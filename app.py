"""
UniFi FaceGraph - local prototype backend.

Proxies a handful of undocumented UniFi Protect private API endpoints so the
browser frontend never has to hold the session cookie / CSRF token itself.

Auth: the frontend shows a login form. Username/password are POSTed once to
/api/auth/login, exchanged for a UniFi OS session cookie + CSRF token, and
those are kept in an in-memory dict for the lifetime of this process only.
Nothing credential-related is ever written to config.json or disk. Restart
the server (or let the session expire) and you'll be prompted to log in
again.

Run with: python3 app.py
Serves HTTPS-only on APP_HOST:APP_PORT (default 127.0.0.1:5151), using a
self-signed cert auto-generated into ./certs on first run (see
cert_utils.py). There is no plain-HTTP listener.

Controller host: set via config.json (direct installs) or the PROTECT_HOST
env var (Docker) -- see README.md.
"""
import base64
import json
import os
import sys
import threading
import time
from pathlib import Path

import requests
import urllib3
from flask import Flask, Response, jsonify, request, send_from_directory

from cert_utils import ensure_self_signed_cert
from face_recognizer import cosine_similarity, embed_image_bytes

# The controller typically presents a self-signed cert on the LAN.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CONFIG_PATH = Path(__file__).parent / "config.json"

if CONFIG_PATH.exists():
    with open(CONFIG_PATH) as f:
        CONFIG = json.load(f)
    CONTROLLER_HOST = CONFIG.get("host")
else:
    CONTROLLER_HOST = os.environ.get("PROTECT_HOST")

if not CONTROLLER_HOST:
    sys.exit(
        "No controller host configured. Either copy config.example.json to "
        "config.json and set 'host' (direct install), or set the "
        "PROTECT_HOST environment variable (Docker) -- see README.md."
    )

BASE_URL = f"https://{CONTROLLER_HOST}"

app = Flask(__name__, static_folder="static", static_url_path="")

# In-memory only. Never persisted to config.json or any file. Cleared on
# server restart, logout, or when the controller rejects a request with 401
# (session expired) -- at which point the frontend re-prompts for login.
session_state = {"cookie": None, "csrf_token": None}


class ControllerUnreachable(Exception):
    pass


class NotAuthenticated(Exception):
    pass


class UpstreamError(Exception):
    def __init__(self, response):
        super().__init__(response.status_code)
        self.response = response


@app.errorhandler(ControllerUnreachable)
def handle_controller_unreachable(exc):
    return jsonify({"error": f"Could not reach controller: {exc}"}), 502


@app.errorhandler(NotAuthenticated)
def handle_not_authenticated(exc):
    return jsonify({"error": "Not logged in", "requiresLogin": True}), 401


@app.errorhandler(UpstreamError)
def handle_upstream_error(exc):
    return proxied_json_response(exc.response)


def _decode_csrf_from_jwt(token_cookie_value):
    """UniFi OS embeds a csrfToken claim in the TOKEN cookie's JWT payload.
    Used as a fallback if the login response doesn't send an explicit
    X-CSRF-Token header. We only decode the payload, no signature check
    (we don't have the secret, and don't need to -- it's our own cookie)."""
    try:
        payload_b64 = token_cookie_value.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return payload.get("csrfToken")
    except Exception:
        return None


def perform_login(username, password, mfa_token=None):
    """
    POSTs to UniFi OS's local login endpoint. This shape (path + body keys)
    is the commonly-documented-by-reverse-engineering UniFi OS login contract,
    but hasn't been HAR-confirmed against this specific UDM/firmware -- if it
    fails, capture the real login request in DevTools and adjust the path/
    body below to match.

    UniFi OS reuses HTTP 499 (normally an nginx-only "client closed request"
    code) as a deliberate signal that the account has 2FA enabled and a TOTP
    code is required -- resubmit with "token" set to that code.
    """
    payload = {"username": username, "password": password, "rememberMe": True}
    if mfa_token:
        payload["token"] = mfa_token

    try:
        resp = requests.post(
            f"{BASE_URL}/api/auth/login",
            json=payload,
            verify=False,
            timeout=15,
        )
    except requests.exceptions.RequestException as exc:
        raise ControllerUnreachable(str(exc)) from exc

    if resp.status_code == 499:
        return "mfa_required", resp.status_code

    if resp.status_code != 200:
        return "failed", resp.status_code

    cookie_header = "; ".join(f"{k}={v}" for k, v in resp.cookies.items())
    csrf_token = resp.headers.get("X-CSRF-Token") or resp.headers.get("X-Updated-CSRF-Token")

    if not csrf_token:
        token_value = resp.cookies.get("TOKEN")
        if token_value:
            csrf_token = _decode_csrf_from_jwt(token_value)

    if not cookie_header or not csrf_token:
        return "failed", resp.status_code

    session_state["cookie"] = cookie_header
    session_state["csrf_token"] = csrf_token
    return "ok", resp.status_code


def session_headers(write=False):
    headers = {"Cookie": session_state["cookie"], "Accept": "application/json"}
    if write:
        headers["X-CSRF-Token"] = session_state["csrf_token"]
        headers["Content-Type"] = "application/json"
    return headers


def controller_get(path, params=None):
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    try:
        resp = requests.get(
            f"{BASE_URL}{path}",
            headers=session_headers(),
            params=params,
            verify=False,
            timeout=15,
        )
    except requests.exceptions.RequestException as exc:
        raise ControllerUnreachable(str(exc)) from exc
    if resp.status_code == 401:
        session_state["cookie"] = None
        session_state["csrf_token"] = None
        raise NotAuthenticated()
    return resp


def controller_post(path, body):
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    try:
        resp = requests.post(
            f"{BASE_URL}{path}",
            headers=session_headers(write=True),
            json=body,
            verify=False,
            timeout=15,
        )
    except requests.exceptions.RequestException as exc:
        raise ControllerUnreachable(str(exc)) from exc
    if resp.status_code == 401:
        session_state["cookie"] = None
        session_state["csrf_token"] = None
        raise NotAuthenticated()
    return resp


def controller_patch(path, body):
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    try:
        resp = requests.patch(
            f"{BASE_URL}{path}",
            headers=session_headers(write=True),
            json=body,
            verify=False,
            timeout=15,
        )
    except requests.exceptions.RequestException as exc:
        raise ControllerUnreachable(str(exc)) from exc
    if resp.status_code == 401:
        session_state["cookie"] = None
        session_state["csrf_token"] = None
        raise NotAuthenticated()
    return resp


def controller_delete(path):
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    try:
        resp = requests.delete(
            f"{BASE_URL}{path}",
            headers=session_headers(write=True),
            verify=False,
            timeout=15,
        )
    except requests.exceptions.RequestException as exc:
        raise ControllerUnreachable(str(exc)) from exc
    if resp.status_code == 401:
        session_state["cookie"] = None
        session_state["csrf_token"] = None
        raise NotAuthenticated()
    return resp


def proxied_json_response(upstream):
    """Pass an upstream JSON (or error) response straight through.
    Some endpoints (e.g. assign-group) return 200 with an empty body on
    success -- treat that as {} rather than a parse error."""
    if not upstream.content:
        return jsonify({}), upstream.status_code
    try:
        payload = upstream.json()
    except ValueError:
        payload = {"error": "non-JSON response from controller", "body": upstream.text[:500]}
    return jsonify(payload), upstream.status_code


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/recognize")
def recognize_page():
    return send_from_directory(app.static_folder, "recognize.html")


@app.route("/api/auth/status")
def auth_status():
    authenticated = bool(session_state["cookie"] and session_state["csrf_token"])
    return jsonify({"authenticated": authenticated})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body = request.get_json(force=True, silent=True) or {}
    username = body.get("username")
    password = body.get("password")
    mfa_token = body.get("token")
    if not username or not password:
        return jsonify({"error": "username and password are required"}), 400

    result, status_code = perform_login(username, password, mfa_token)
    # username/password/mfa_token go out of scope when this function returns;
    # they are never stored in session_state, config, or written anywhere.
    if result == "mfa_required":
        return jsonify({"error": "Two-factor authentication code required", "mfaRequired": True}), 401
    if result == "failed":
        return jsonify({"error": f"Login failed (controller returned {status_code})"}), 401
    _restart_unknown_cache(start_loading=False)
    return jsonify({"authenticated": True})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session_state["cookie"] = None
    session_state["csrf_token"] = None
    _restart_unknown_cache(start_loading=False)
    return jsonify({"authenticated": False})


@app.route("/api/groups")
def get_groups():
    """
    HAR-confirmed to match what the real Known Faces list uses (two
    "labels" params, the second a superset of the first -- replicated as-is
    even though the duplication looks redundant, since that's what the real
    UI sends). Originally this used an unconfirmed "hasName=true" param
    instead, which appears to have excluded freshly-promoted
    "face_degraded_..." groups after using the create-person flow.
    """
    upstream = controller_get(
        "/proxy/protect/api/recognition/face/groups",
        params={
            "labels": [
                "groupType:known,groupType:interest",
                "groupType:known,groupType:interest,groupType:degraded",
            ],
            "orderBy": "name",
            "orderDirection": "asc",
            "pageSize": 1000000,
        },
    )
    return proxied_json_response(upstream)


MAX_DETECTION_REQUESTS = 5000
INITIAL_WINDOW_MS = 6 * 60 * 60 * 1000
MIN_WINDOW_MS = 60 * 1000
TARGET_EVENTS_PER_REQUEST = (100, 500)


def _iter_detection_batches(labels, start=0, end=None):
    """
    Yield batches of detection-search events in [start, end], newest first.

    The controller caps "limit" at 100, so the only way to see further back
    is a start/end range. Asking for the whole range at once can mean one
    enormous response (slow to arrive, and nothing to show until it does),
    so this walks backwards in time windows instead, resizing the window to
    keep each response at a few hundred events: it doubles across quiet or
    empty stretches (so reaching the start of history is quick) and halves
    when a window comes back too full.

    Whether a range response is itself silently capped isn't confirmed, so
    the next window always ends just before the oldest event received
    rather than at the previous window's start -- if the controller did
    truncate, the walk picks up exactly where it left off.
    """
    if end is None:
        end = int(time.time() * 1000)
    seen_ids = set()
    window = INITIAL_WINDOW_MS
    for _ in range(MAX_DETECTION_REQUESTS):
        if end < start:
            return
        window_start = max(start, end - window)
        resp = controller_get(
            "/proxy/protect/api/detection-search",
            params={
                "excludeMotion": "true",
                "labels": labels,
                "orderDirection": "DESC",
                "start": window_start,
                "end": end,
            },
        )
        if resp.status_code != 200:
            raise UpstreamError(resp)
        batch = resp.json().get("events", [])
        new = [e for e in batch if e.get("id") not in seen_ids]
        for e in new:
            seen_ids.add(e.get("id"))
        if new:
            yield new

        oldest = min((e.get("start") for e in new if e.get("start") is not None), default=None)
        if oldest is not None and window_start < oldest <= end:
            end = oldest - 1
        else:
            if window_start <= start:
                return
            end = window_start - 1

        if len(batch) > TARGET_EVENTS_PER_REQUEST[1]:
            window = max(MIN_WINDOW_MS, window // 2)
        elif len(batch) < TARGET_EVENTS_PER_REQUEST[0]:
            window *= 2


def _fetch_detection_events(labels, start=0, end=None):
    events = []
    for batch in _iter_detection_batches(labels, start, end):
        events.extend(batch)
    return events


def _unknown_faces_from_events(events):
    faces = []
    for event in events:
        for t in event.get("metadata", {}).get("detectedThumbnails", []):
            if t.get("type") != "face":
                continue
            if "groupType:unknown" not in (t.get("labels") or []):
                continue
            faces.append(
                {
                    "objectId": t.get("objectId"),
                    "croppedId": t.get("croppedId"),
                    "groupId": (t.get("group") or {}).get("id"),
                    "confidence": t.get("confidence"),
                    "qualityScore": (t.get("attributes") or {}).get("qualityScore"),
                    "camera": event.get("camera"),
                    "timestamp": event.get("start"),
                }
            )
    return faces


# --- Unknown faces cache (main page) ---------------------------------------
#
# The full unknown history can be tens of thousands of faces -- far too many
# to fetch per page view. A background thread reads it newest-first into
# memory and the main page is served from that in UNKNOWN_PAGE_SIZE pages,
# so page 1 is ready as soon as the first ~1000 faces are in, while later
# page tabs appear as the walk continues. Re-read only on an explicit
# Refresh (or after logging in again). Faces assigned through this app are
# dropped from the cache as they go; faces that *become* unknown (unassign,
# deleting a person) only show up after a Refresh.

UNKNOWN_PAGE_SIZE = 1000

unknown_cache_lock = threading.Lock()
unknown_cache = {"generation": 0, "status": "idle", "faces": [], "error": None}


def _load_unknown_cache(generation):
    try:
        for batch in _iter_detection_batches("smartDetectType:face"):
            faces = _unknown_faces_from_events(batch)
            with unknown_cache_lock:
                if unknown_cache["generation"] != generation:
                    return  # superseded by a Refresh or logout
                unknown_cache["faces"].extend(faces)
        status, error = "done", None
    except NotAuthenticated:
        status, error = "error", "Not logged in"
    except UpstreamError as exc:
        status, error = "error", f"Controller returned {exc.response.status_code}"
    except Exception as exc:
        status, error = "error", str(exc)
    with unknown_cache_lock:
        if unknown_cache["generation"] == generation:
            unknown_cache["status"] = status
            unknown_cache["error"] = error


def _restart_unknown_cache(start_loading=True):
    with unknown_cache_lock:
        unknown_cache["generation"] += 1
        unknown_cache["faces"] = []
        unknown_cache["error"] = None
        unknown_cache["status"] = "loading" if start_loading else "idle"
        generation = unknown_cache["generation"]
    if start_loading:
        threading.Thread(target=_load_unknown_cache, args=(generation,), daemon=True).start()


def _drop_from_unknown_cache(object_ids):
    ids = set(object_ids)
    with unknown_cache_lock:
        unknown_cache["faces"] = [f for f in unknown_cache["faces"] if f["objectId"] not in ids]


def _unknown_cache_summary():
    """Caller holds unknown_cache_lock."""
    total = len(unknown_cache["faces"])
    loading = unknown_cache["status"] == "loading"
    # While loading, only count pages that are already full -- the last
    # partial one is still growing.
    total_pages = total // UNKNOWN_PAGE_SIZE if loading else max(1, -(-total // UNKNOWN_PAGE_SIZE))
    return {
        "pageSize": UNKNOWN_PAGE_SIZE,
        "total": total,
        "totalPages": total_pages,
        "loading": loading,
        "error": unknown_cache["error"],
    }


@app.route("/api/unknowns")
def get_unknowns():
    """One page (1-based) of unknown faces, newest first. "ready" is false
    if that page hasn't finished loading yet -- poll again."""
    if unknown_cache["status"] == "idle":
        _restart_unknown_cache()
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1
    with unknown_cache_lock:
        summary = _unknown_cache_summary()
        lo = (page - 1) * UNKNOWN_PAGE_SIZE
        hi = lo + UNKNOWN_PAGE_SIZE
        ready = not summary["loading"] or len(unknown_cache["faces"]) >= hi
        faces = unknown_cache["faces"][lo:hi] if ready else []
    return jsonify({**summary, "page": page, "ready": ready, "faces": faces})


@app.route("/api/unknowns/status")
def get_unknowns_status():
    with unknown_cache_lock:
        return jsonify(_unknown_cache_summary())


@app.route("/api/unknowns/refresh", methods=["POST"])
def refresh_unknowns():
    _restart_unknown_cache()
    return jsonify({"ok": True})


@app.route("/api/groups/<group_id>/detections")
def get_group_detections(group_id):
    """
    The controller caps "limit" at 100 (confirmed via its own error message:
    "start and end are both required unless a valid limit is passed
    (1-100)"). To get a person's full detection history rather than just
    their most recent 100, the frontend passes start/end (that person's
    firstDetectedAt/lastDetectedAt from the groups list) as query params,
    which we forward instead of limit.
    """
    start = request.args.get("start")
    end = request.args.get("end")
    params = {
        "excludeMotion": "true",
        "labels": [f"group:{group_id}", "smartDetectType:face"],
        "orderDirection": "DESC",
    }
    if start and end:
        params["start"] = start
        params["end"] = end
    else:
        params["limit"] = 100
    upstream = controller_get("/proxy/protect/api/detection-search", params=params)
    return proxied_json_response(upstream)


@app.route("/api/groups/<group_id>", methods=["DELETE"])
def delete_group(group_id):
    upstream = controller_delete(f"/proxy/protect/api/recognition/face/groups/{group_id}")
    return proxied_json_response(upstream)


@app.route("/api/cameras")
def get_cameras():
    """
    Camera id -> name mapping. The controller's "bootstrap" endpoint returns
    a large blob of NVR/system state (access keys, users, every device
    type); we only pull out the small cameras list rather than exposing the
    whole thing to the browser.
    """
    upstream = controller_get("/proxy/protect/api/bootstrap")
    if upstream.status_code != 200:
        return proxied_json_response(upstream)
    try:
        data = upstream.json()
    except ValueError:
        return jsonify({"error": "non-JSON response from controller"}), 502
    cameras = [{"id": c.get("id"), "name": c.get("name")} for c in data.get("cameras", [])]
    return jsonify({"cameras": cameras})


@app.route("/api/assign", methods=["POST"])
def assign_group():
    body = request.get_json(force=True, silent=True) or {}
    object_ids = body.get("objectIds")
    group_id = body.get("groupId")
    if not object_ids or not group_id:
        return jsonify({"error": "objectIds and groupId are required"}), 400

    upstream = controller_post(
        "/proxy/protect/api/recognition/face/assign-group",
        {"objectIds": object_ids, "groupId": group_id},
    )
    if upstream.ok:
        _drop_from_unknown_cache(object_ids)
    return proxied_json_response(upstream)


@app.route("/api/unassign", methods=["POST"])
def unassign_faces():
    """Sends selected faces back to being unknown. Each one lands in its own
    freshly auto-generated group (controller's "misrecognition" endpoint)."""
    body = request.get_json(force=True, silent=True) or {}
    object_ids = body.get("objectIds")
    if not object_ids:
        return jsonify({"error": "objectIds is required"}), 400

    upstream = controller_post(
        "/proxy/protect/api/recognition/v2/misrecognition",
        {"objectIds": object_ids},
    )
    return proxied_json_response(upstream)


@app.route("/api/create-person", methods=["POST"])
def create_person():
    """
    Every unknown face already implicitly belongs to its own auto-generated
    "face_degraded_..." group. There's no separate "create group" call --
    naming a person means PATCHing that anchor face's group with a name
    (promoting it in place), then assign-group-ing any other selected faces
    into that same group id.
    """
    body = request.get_json(force=True, silent=True) or {}
    anchor_group_id = body.get("anchorGroupId")
    object_ids = body.get("objectIds")
    name = body.get("name")
    if not anchor_group_id or not object_ids or not name:
        return jsonify({"error": "anchorGroupId, objectIds, and name are required"}), 400

    patch_upstream = controller_patch(
        f"/proxy/protect/api/recognition/face/groups/{anchor_group_id}",
        {"name": name, "description": None, "isNotificationEnabled": False},
    )
    if patch_upstream.status_code != 200:
        return proxied_json_response(patch_upstream)

    assign_upstream = controller_post(
        "/proxy/protect/api/recognition/face/assign-group",
        {"objectIds": object_ids, "groupId": anchor_group_id},
    )
    if assign_upstream.ok:
        _drop_from_unknown_cache(object_ids)
    return proxied_json_response(assign_upstream)


@app.route("/api/group-image/<group_id>")
def group_image(group_id):
    upstream = controller_get(f"/proxy/protect/api/recognition/face/groups/{group_id}/image")
    if upstream.status_code != 200:
        return jsonify({"error": "failed to fetch group image"}), upstream.status_code
    content_type = upstream.headers.get("Content-Type", "image/jpeg")
    return Response(upstream.content, content_type=content_type)


@app.route("/api/detection-image/<cropped_id>")
def detection_image(cropped_id):
    upstream = controller_get(f"/proxy/protect/api/thumbnails/{cropped_id}")
    if upstream.status_code != 200:
        return jsonify({"error": "failed to fetch detection image"}), upstream.status_code
    content_type = upstream.headers.get("Content-Type", "image/jpeg")
    return Response(upstream.content, content_type=content_type)


# --- Local face recognition (InsightFace, runs on this machine only) -------
#
# Deliberately doesn't use any of UniFi's own face data/embeddings -- only
# the raw cropped face images, fetched fresh and run through our own local
# model. Runs as a background thread (this can take a while: every known
# person's full photo history, plus every current unknown detection, each
# needing an HTTP fetch + local inference), polled via /api/recognize/status.

recognition_state = {
    "status": "idle",  # idle | running | done | error
    "stage": "",
    "current": 0,
    "total": 0,
    "results": None,
    "lowConfidenceResults": None,
    "error": None,
}
recognition_lock = threading.Lock()

# Reference/unknown photos below this qualityScore are skipped entirely
# before embedding -- blurry/bad-angle crops produce noisy embeddings that
# are a likely source of bad matches. Not exposed in the UI (yet); the
# match-confidence threshold below is the user-facing knob.
MIN_QUALITY_SCORE = 20


def _fetch_group_reference_faces(group):
    """{croppedId, qualityScore} for every face thumbnail currently assigned
    to this known person."""
    if not group.get("firstDetectedAt") or not group.get("lastDetectedAt"):
        return []
    resp = controller_get(
        "/proxy/protect/api/detection-search",
        params={
            "excludeMotion": "true",
            "labels": [f"group:{group['id']}", "smartDetectType:face"],
            "orderDirection": "DESC",
            "start": group["firstDetectedAt"],
            "end": group["lastDetectedAt"],
        },
    )
    if resp.status_code != 200:
        return []
    events = resp.json().get("events", [])
    faces = []
    for event in events:
        for t in event.get("metadata", {}).get("detectedThumbnails", []):
            if t.get("type") != "face":
                continue
            if (t.get("group") or {}).get("id") != group["id"]:
                continue
            if t.get("croppedId"):
                faces.append({"croppedId": t["croppedId"], "qualityScore": (t.get("attributes") or {}).get("qualityScore")})
    return faces


def _fetch_unknown_faces(start=None, end=None):
    try:
        events = _fetch_detection_events("smartDetectType:face", start or 0, end)
    except UpstreamError:
        return []
    return [f for f in _unknown_faces_from_events(events) if f["croppedId"]]


def _passes_quality_filter(quality_score):
    return quality_score is None or quality_score >= MIN_QUALITY_SCORE


def _fetch_thumbnail_bytes(cropped_id):
    resp = controller_get(f"/proxy/protect/api/thumbnails/{cropped_id}")
    if resp.status_code != 200:
        return None
    return resp.content


def run_recognition_job(start=None, end=None, match_threshold=0.4):
    try:
        recognition_state.update(
            status="running",
            stage="Loading known people",
            current=0,
            total=0,
            results=None,
            lowConfidenceResults=None,
            error=None,
        )

        groups_resp = controller_get(
            "/proxy/protect/api/recognition/face/groups",
            params={
                "labels": [
                    "groupType:known,groupType:interest",
                    "groupType:known,groupType:interest,groupType:degraded",
                ],
                "orderBy": "name",
                "orderDirection": "asc",
                "pageSize": 1000000,
            },
        )
        groups = groups_resp.json().get("groups", []) if groups_resp.status_code == 200 else []

        ref_jobs = []  # (group_id, cropped_id)
        for g in groups:
            for ref_face in _fetch_group_reference_faces(g):
                if not _passes_quality_filter(ref_face["qualityScore"]):
                    continue
                ref_jobs.append((g["id"], ref_face["croppedId"]))

        unknown_faces = [f for f in _fetch_unknown_faces(start, end) if _passes_quality_filter(f["qualityScore"])]

        recognition_state.update(total=len(ref_jobs) + len(unknown_faces), stage="Embedding known people's faces")

        person_embeddings = {}  # group_id -> list of embeddings
        for group_id, cropped_id in ref_jobs:
            image_bytes = _fetch_thumbnail_bytes(cropped_id)
            if image_bytes:
                emb = embed_image_bytes(image_bytes)
                if emb is not None:
                    person_embeddings.setdefault(group_id, []).append(emb)
            recognition_state["current"] += 1

        if not person_embeddings:
            recognition_state.update(
                status="done",
                stage="Done",
                results=[],
                lowConfidenceResults=[],
                error="No usable reference photos could be found for any known person.",
            )
            return

        recognition_state["stage"] = "Embedding unknown faces and matching"
        matches_by_group = {g["id"]: [] for g in groups}
        low_confidence_by_group = {g["id"]: [] for g in groups}
        for face in unknown_faces:
            image_bytes = _fetch_thumbnail_bytes(face["croppedId"])
            emb = embed_image_bytes(image_bytes) if image_bytes else None
            recognition_state["current"] += 1
            if emb is None:
                continue
            best_group_id, best_score = None, -1.0
            for group_id, embs in person_embeddings.items():
                score = max(cosine_similarity(emb, ref) for ref in embs)
                if score > best_score:
                    best_score, best_group_id = score, group_id
            if best_group_id is None:
                continue
            bucket = matches_by_group if best_score >= match_threshold else low_confidence_by_group
            bucket[best_group_id].append({**face, "score": round(best_score, 4)})

        for bucket in (matches_by_group, low_confidence_by_group):
            for group_id in bucket:
                bucket[group_id].sort(key=lambda m: m["score"], reverse=True)

        results = [
            {"group": g, "matches": matches_by_group.get(g["id"], [])}
            for g in groups
            if matches_by_group.get(g["id"])
        ]
        low_confidence_results = [
            {"group": g, "matches": low_confidence_by_group.get(g["id"], [])}
            for g in groups
            if low_confidence_by_group.get(g["id"])
        ]
        recognition_state.update(
            status="done", stage="Done", results=results, lowConfidenceResults=low_confidence_results, error=None
        )
    except NotAuthenticated:
        recognition_state.update(status="error", error="Session expired -- log in again and retry.")
    except ControllerUnreachable as exc:
        recognition_state.update(status="error", error=f"Could not reach controller: {exc}")
    except Exception as exc:  # last-resort guard so the background thread never dies silently
        recognition_state.update(status="error", error=str(exc))


@app.route("/api/recognize/start", methods=["POST"])
def recognize_start():
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    body = request.get_json(force=True, silent=True) or {}
    start = body.get("start")
    end = body.get("end")
    try:
        match_threshold = float(body.get("matchThreshold", 0.4))
    except (TypeError, ValueError):
        match_threshold = 0.4
    with recognition_lock:
        if recognition_state["status"] == "running":
            return jsonify({"error": "Recognition is already running"}), 409
        recognition_state.update(
            status="running", stage="Starting…", current=0, total=0, results=None, lowConfidenceResults=None, error=None
        )
    thread = threading.Thread(target=run_recognition_job, args=(start, end, match_threshold), daemon=True)
    thread.start()
    return jsonify({"status": "running"})


@app.route("/api/recognize/status")
def recognize_status():
    return jsonify(recognition_state)


# --- Clustering (group unknown faces against each other) -------------------
#
# Only computes embeddings server-side (same background-job/polling pattern
# as recognition above) and hands them to the frontend, which does the
# actual threshold-based grouping in JS -- that keeps the similarity
# threshold slider instantly responsive (no server round-trip per tweak)
# instead of re-running the whole embedding pass every time it moves.

cluster_state = {
    "status": "idle",  # idle | running | done | error
    "stage": "",
    "current": 0,
    "total": 0,
    "faces": None,
    "error": None,
}
cluster_lock = threading.Lock()


def run_cluster_embedding_job(start=None, end=None):
    try:
        cluster_state.update(status="running", stage="Loading unknown faces", current=0, total=0, faces=None, error=None)

        unknown_faces = [f for f in _fetch_unknown_faces(start, end) if _passes_quality_filter(f["qualityScore"])]
        cluster_state.update(total=len(unknown_faces), stage="Embedding unknown faces")

        embedded_faces = []
        for face in unknown_faces:
            image_bytes = _fetch_thumbnail_bytes(face["croppedId"])
            emb = embed_image_bytes(image_bytes) if image_bytes else None
            cluster_state["current"] += 1
            if emb is None:
                continue
            embedded_faces.append({**face, "embedding": emb.tolist()})

        cluster_state.update(status="done", stage="Done", faces=embedded_faces, error=None)
    except NotAuthenticated:
        cluster_state.update(status="error", error="Session expired -- log in again and retry.")
    except ControllerUnreachable as exc:
        cluster_state.update(status="error", error=f"Could not reach controller: {exc}")
    except Exception as exc:
        cluster_state.update(status="error", error=str(exc))


@app.route("/api/cluster/start", methods=["POST"])
def cluster_start():
    if not session_state["cookie"] or not session_state["csrf_token"]:
        raise NotAuthenticated()
    body = request.get_json(force=True, silent=True) or {}
    start = body.get("start")
    end = body.get("end")
    with cluster_lock:
        if cluster_state["status"] == "running":
            return jsonify({"error": "Clustering is already running"}), 409
        cluster_state.update(status="running", stage="Starting…", current=0, total=0, faces=None, error=None)
    thread = threading.Thread(target=run_cluster_embedding_job, args=(start, end), daemon=True)
    thread.start()
    return jsonify({"status": "running"})


@app.route("/api/cluster/status")
def cluster_status():
    return jsonify(cluster_state)


@app.route("/cluster")
def cluster_page():
    return send_from_directory(app.static_folder, "cluster.html")


if __name__ == "__main__":
    # threaded=True so /api/recognize/status (and /api/cluster/status) can
    # be polled while a background job is in progress on its own thread.
    #
    # APP_HOST defaults to 127.0.0.1 (localhost-only) for direct installs --
    # override to 0.0.0.0 to make it reachable from other devices on your
    # LAN (the Docker image sets this for you, since a container is only
    # reachable via its published port regardless of the bind address).
    # FLASK_DEBUG defaults off: the Werkzeug debugger is a real remote-code-
    # execution risk if this ends up reachable beyond localhost.
    #
    # HTTPS-only, via a self-signed cert generated once into ./certs and
    # reused on subsequent starts -- there is no plain-HTTP listener at all,
    # so there's nothing to "block" separately.
    cert_path, key_path = ensure_self_signed_cert()
    app.run(
        host=os.environ.get("APP_HOST", "127.0.0.1"),
        port=int(os.environ.get("APP_PORT", 5151)),
        debug=os.environ.get("FLASK_DEBUG", "false").lower() == "true",
        threaded=True,
        ssl_context=(cert_path, key_path),
    )
