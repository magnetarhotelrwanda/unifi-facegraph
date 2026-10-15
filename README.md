# UniFi FaceGraph

Local prototype for reviewing UniFi Protect face detections and assigning
unknown ones to known people. Flask backend proxies a handful of
**undocumented private Protect API endpoints** (reverse-engineered via HAR
capture against Protect 7.1.87 / UniFi OS 5.1.26 — not part of Ubiquiti's
public Integration API, and could change or break on a controller update).

Vanilla HTML/JS/CSS frontend, no build step. Single-user, LAN-only.

## AI Code

This is code written by claude so it is indeed AI slop. 
I used claude to put this together after reverse engineering the API needed for this.
Feel free to use whats in here for a non AI slop porject

## Auth

The app has an in-page login screen (username + password for your UniFi
controller/UDM). On submit, the backend exchanges those for a session cookie
+ CSRF token by POSTing to the controller's own `/api/auth/login` endpoint,
then **keeps the cookie/CSRF token in memory only, for the lifetime of the
running `python3 app.py` process.** Nothing credential-related — not the
password, not the resulting cookie — is ever written to `config.json` or any
file. Restart the server, click "Log out", or let the session expire and
you're dropped back to the login screen.

Note: the login request shape (`POST /api/auth/login` with
`{username, password, rememberMe}`) is the commonly-known UniFi OS login
contract, but hasn't been HAR-confirmed against this specific
controller/firmware the way the other four endpoints have. If login fails
unexpectedly, capture the real login request in DevTools and adjust
`perform_login()` in [app.py](app.py) to match.

## HTTPS

The app is **HTTPS-only** — there's no plain-HTTP listener at all, so make
sure you're using `https://`, not `http://`. On first run it generates its
own self-signed certificate into `./certs` (see
[cert_utils.py](cert_utils.py)) and reuses it on every subsequent start, so
you're not re-trusting a new cert on every restart.

Being self-signed, your browser will still show a one-time "not secure" /
"proceed anyway" warning per browser/device the first time you visit —
that's inherent to any self-signed cert (no publicly-trusted CA signed it),
not something this app can avoid on a private LAN IP. It gets you an
encrypted connection, not a green padlock. If you want to get rid of the
browser warning entirely, put a reverse proxy (Caddy, nginx, Traefik) with
a real cert in front of this app — not set up here, since it needs a
public domain pointed at your server.

## Setup

Two ways to run this: directly with Python, or in Docker. Both need nothing
from you except your controller's IP — auth is handled entirely through the
in-page login screen (see [Auth](#auth) below), never stored on disk.

### Option A: Direct install

1. Install dependencies:

   ```bash
   pip3 install -r requirements.txt
   ```

2. Download the local face-recognition model (one-time, ~182MB, only needed
   for the [Recognition](#local-face-recognition-recognize)/[Cluster](#clustering-unknowns-against-each-other-cluster)
   pages — not committed to git, see below):

   ```bash
   python3 download_model.py
   ```

3. Create your config:

   ```bash
   cp config.example.json config.json
   ```

4. Set `host` in `config.json` to your Protect controller/UDM's IP (e.g.
   `192.168.1.1`). `config.json` is gitignored — it holds no credentials,
   just the host.

5. Run it:

   ```bash
   python3 app.py
   ```

6. Open [https://127.0.0.1:5151](https://127.0.0.1:5151) and log in with your
   controller username/password.

By default the server only binds to `127.0.0.1` (this machine only). To make
it reachable from other devices on your LAN (e.g. running it on a home
server), set `APP_HOST=0.0.0.0` — see [Environment variables](#environment-variables)
below.

### Option B: Docker

No `config.json` needed here — set the controller host via the
`PROTECT_HOST` environment variable instead.

```bash
docker compose up -d --build
```

Edit the `PROTECT_HOST` value in [docker-compose.yml](docker-compose.yml)
first (defaults to `192.168.1.1`), or override it inline:

```bash
PROTECT_HOST=192.168.1.1 docker compose up -d --build
```

Or without Compose:

```bash
docker build -t unifi-facegraph .
docker run -d -p 5151:5151 -e PROTECT_HOST=192.168.1.1 --name unifi-facegraph unifi-facegraph
```

Then open [https://127.0.0.1:5151](https://127.0.0.1:5151) (or
`https://<your-server-ip>:5151` if running on a remote machine) and log in.

The model download (`download_model.py`) runs automatically during
`docker build`, not at container startup — so `docker build` itself is slow
the first time (dependency install + ~182MB model download), but starting/
restarting the container afterward is instant.

**Note**: build/run-tested on Ubuntu (`docker compose up -d --build`). If
`opencv`/`onnxruntime` complain about a missing shared library in `docker
compose logs`, it's the same class of issue as `libgl1` below — add
whatever's missing to the `apt-get install` line in the
[Dockerfile](Dockerfile).

### Environment variables

All optional except `PROTECT_HOST` (only needed if you're not using
`config.json`):

| Variable | Default | Purpose |
|---|---|---|
| `PROTECT_HOST` | — | Controller IP/hostname. Fallback used only if `config.json` doesn't exist. Docker deployments should always use this instead of baking a config file into the image. |
| `APP_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to expose beyond localhost (the Docker image sets this automatically). |
| `APP_PORT` | `5151` | Port to listen on. |
| `FLASK_DEBUG` | `false` | Enables Flask's debug mode/auto-reload for local development. **Leave this off** anywhere reachable beyond localhost — the Werkzeug interactive debugger is a real remote-code-execution risk if exposed. |

Note: `pip3 install -r requirements.txt` also pulls in `insightface`,
`onnxruntime`, `opencv-python-headless`, and `numpy` for the local face
recognition/clustering pages — a heavier install than the rest of the app
(a couple hundred MB of packages). The model weights (~182MB, after pruning
the model files this app doesn't use — see `download_model.py`) are **not**
committed to git (GitHub hard-blocks any single file over 100MB, and the
recognition model alone is 166MB before pruning) — run `python3
download_model.py` once as a setup step instead (or let `docker build` do
it for you).

## How it works

- **Known Faces** grid — loads named face groups (`GET /api/groups` →
  `/proxy/protect/api/recognition/face/groups`, using the exact
  `labels=groupType:known,groupType:interest` (+ a second broader `labels`
  param) query the real Known Faces list uses, HAR-confirmed) and renders
  each one's avatar via `GET /api/group-image/<id>` (confirmed working). This
  replaced an earlier, unconfirmed `hasName=true` param that appeared to
  exclude freshly-promoted `face_degraded_...` groups (i.e. newly-created
  people wouldn't show up here even though the create succeeded on the
  controller).
- **Unknown Detections** grid — loads *every* face detection (`GET
  /api/detections` → `/proxy/protect/api/detection-search`, paged backwards
  in time with `start`/`end` until the controller returns nothing older),
  then the
  **frontend** flattens each event's `detectedThumbnails[]` and buckets faces
  as unknown when that thumbnail's `labels[]` contains `"groupType:unknown"`.
  This bucketing intentionally happens client-side rather than via a
  server-side "unknown" filter param, since no such param has been confirmed
  against the real API. (Earlier versions checked the `group.id` prefix
  instead — that was wrong: a named person's group id permanently keeps its
  original `face_degraded_...` shape, and `group` turned out to be a
  top-level field on the thumbnail, not nested under `attributes` as
  originally assumed. The `groupType` label is the only reliable signal,
  HAR-confirmed by watching a face's label flip from `groupType:unknown` to
  `groupType:known` after naming it.) Each unknown card's thumbnail loads via
  `GET /api/detection-image/<croppedId>` → `/proxy/protect/api/thumbnails/<croppedId>`
  (HAR-confirmed), falling back to a placeholder icon if a specific thumbnail
  fails to load.
- **Assign flow** — click one or more unknown detection cards to select them
  (multi-select), then click a known person's card to batch-assign via
  `POST /api/assign` → `/proxy/protect/api/recognition/face/assign-group`.
  Successfully-assigned cards are removed from the grid immediately.
- **Create new person** — select one or more unknown detections, type a name
  in the field above the Unknown Detections grid, and click "Name selected as
  new person". There's no dedicated "create group" endpoint: every unknown
  face already implicitly belongs to its own auto-generated
  `face_degraded_...` group, so this just `PATCH`es that anchor face's group
  with a name (`POST /api/create-person` → `PATCH
  /proxy/protect/api/recognition/face/groups/<id>` then, for any additional
  selected faces, `POST .../assign-group` into that same group id).
- **Group detail view** — click a known person's card (with nothing selected)
  to open their detail page: all detections currently assigned to them (`GET
  /api/groups/<id>/detections` → `detection-search` filtered by
  `labels=group:<id>`), each selectable. The controller caps `limit` at 100
  (confirmed via its own error: `"start and end are both required unless a
  valid limit is passed (1-100)"`), so to get someone's *full* history rather
  than just their most recent 100 detections, the frontend instead passes
  `start`/`end` — that person's `firstDetectedAt`/`lastDetectedAt` from the
  groups list — which the backend forwards in place of `limit`. From there
  you can:
  - **Unassign** selected detections back to unknown (`POST /api/unassign` →
    `/proxy/protect/api/recognition/v2/misrecognition`) — each one lands in
    its own fresh unknown group.
  - **Reassign** selected detections to a different known person by clicking
    them in the "Reassign to" strip (same `/api/assign` call as the main
    flow).
  - **Delete this person** — confirm via a browser dialog, then `DELETE
    /api/groups/<id>` → `DELETE
    /proxy/protect/api/recognition/face/groups/<id>` (HAR-confirmed, no
    body). Their past detections become unknown again rather than
    disappearing.
  Leaving the detail view (Back button, or after a delete) triggers a full
  refresh so the main grids reflect anything unassigned/reassigned/deleted
  while you were in there.
- **Camera names** — detection cards show the camera's actual name (e.g.
  "Living Room Camera") instead of its raw id. `GET /api/cameras` →
  `/proxy/protect/api/bootstrap` (HAR-confirmed), from which the backend
  extracts just `cameras[].id`/`.name` rather than exposing the rest of that
  endpoint's much larger NVR/system state blob to the browser. Fetched once
  per session and cached client-side, since the camera list rarely changes.

## Local face recognition ([/recognize](https://127.0.0.1:5151/recognize))

A separate page that runs its own local face-recognition model against your
photos — **deliberately not using any of UniFi's own recognition data or
embeddings** (UniFi's own detections do include a `faceEmbed` vector, but
that was explicitly ruled out — the point of this page is a second, better
opinion, not reusing the same one).

- **Model**: [InsightFace](https://github.com/deepinsight/insightface)
  (`buffalo_l` / ArcFace), running on CPU only. Downloaded once via `python3
  download_model.py` (see Setup above) into `models/` — gitignored, not
  fetched at page-load/request time — see [face_recognizer.py](face_recognizer.py). (Google
  Coral/Edge TPU was considered and deliberately skipped: it accelerates
  *inference speed*, not *match accuracy* — quantizing to INT8 for the Edge
  TPU typically makes a model slightly *less* accurate than the FP32 CPU
  version here, and Coral's driver/runtime support is mostly Linux-first
  anyway. Worth revisiting only if runs become too slow, not to fix
  mismatches.)
- **Date range**: pick a start/end date, or check "process all unknown
  detections" to bypass it. The controller caps `limit` at 100 for the plain
  activity feed, so — like the group detail view — a date range uses
  `start`/`end` params instead, with no such cap.
- **Minimum match confidence** slider: unknown faces whose best score is
  below this are kept separate in a "Below confidence threshold" section
  instead of being force-assigned to whichever known person is merely
  *closest* — review those manually rather than bulk-approving them.
- Reference/unknown photos with a `qualityScore` below `MIN_QUALITY_SCORE`
  (20, in [app.py](app.py)) are skipped entirely before embedding — noisy
  crops (blurry, bad angle) were a likely source of bad matches.
- **Click "Run recognition"** to kick off a background job (`POST
  /api/recognize/start`, polled via `GET /api/recognize/status` every
  second so the page isn't stuck waiting on one long request — a full run
  can take anywhere from tens of seconds to several minutes depending on
  how many photos your known people have and how wide a date range you
  picked):
  1. For every known person, fetch **every** currently-assigned detection
     (their full history via the same `start`/`end` group-detail endpoint
     used elsewhere), fetch each one's actual cropped image
     (`/proxy/protect/api/thumbnails/<croppedId>`), and run it through the
     local model to get a reference embedding. (Thumbnail crops are tight
     around the face, which can trip up InsightFace's own detector, so
     images are padded ~40% before detection.)
  2. For every unknown detection in the picked date range, do the same,
     then compare its embedding (cosine similarity) against every known
     person's reference embeddings and assign it to whichever person it's
     closest to — if that score clears the confidence slider.
  3. Group and sort the results (and separately, the below-threshold ones)
     by known person, each with their suggested matches ranked by score.
- **Results page** works like the main page: click matches to select them,
  "Select all" per person, then "Approve selected" or "Approve ALL suggested
  matches" — both just call the same `/api/assign` endpoint the main page
  uses, batched per person.
- Results are **not saved between runs** — re-running starts fresh (no
  caching of embeddings), and results live only in server memory until the
  process restarts.

## Clustering unknowns against each other ([/cluster](https://127.0.0.1:5151/cluster))

A third page for the opposite problem: a recurring face that was never
assigned to anyone (e.g. "the postman") won't show up on the recognition
page above, since there's no known person to match it against. This page
instead compares unknown faces **against each other**.

- **Click "Compute embeddings"** to run the same kind of background job as
  the recognition page, but only embedding unknown detections in the picked
  date range — no known-person reference photos involved (`POST
  /api/cluster/start` / `GET /api/cluster/status`).
- Once embeddings are ready, **grouping happens entirely client-side** in
  JS, via a similarity-threshold slider. This is deliberate: computing
  embeddings is the slow part (one HTTP fetch + local inference per photo),
  but re-grouping a few hundred already-computed embeddings by a new
  threshold is fast enough to redo on every slider move (~n² cosine-similarity
  comparisons, connected via a union-find), so the slider re-clusters
  instantly with no server round-trip. Lower the threshold if the same
  person is being split into multiple small groups; raise it if different
  people are getting merged into one.
- Each group of 2+ faces can be **named as a new person** (reuses the same
  anchor-group `/api/create-person` trick as the main page's create-person
  flow) or **assigned to an existing known person** (same `/api/assign`
  call). Faces are pre-selected by default within a group — click one to
  exclude it (e.g. an obvious outlier) before naming/assigning.
- Faces that didn't cluster with anything else at the current threshold are
  listed separately under "Ungrouped" (view-only, not actionable there —
  find them on the main page or recognition page instead).

## Known gaps (prototype, not v1)

- **Login endpoint is unconfirmed** (see Auth section above) — if it doesn't
  work against your controller out of the box, it likely just needs a small
  tweak based on a real HAR capture of your login flow.
- **Recognition/clustering runs have no cancel button** once started
  (they'll finish or error out on their own; the page just stops polling if
  you navigate away).
- **Clustering's "Ungrouped" faces aren't actionable** on that page — no
  select/assign there, just visibility into what didn't get grouped.

## Project layout

```
app.py                  Flask backend (proxies Protect API, handles login/recognition/clustering jobs, serves frontend)
face_recognizer.py      Local InsightFace embedding logic (image bytes -> vector)
cert_utils.py           Generates/reuses the self-signed HTTPS cert into ./certs
download_model.py       One-time setup: downloads the InsightFace model pack into ./models
models/                 InsightFace buffalo_l model pack (gitignored — run download_model.py to populate)
certs/                  Self-signed HTTPS cert + key (gitignored — auto-generated on first run)
config.example.json     Template — copy to config.json and fill in
config.json              Your controller host (gitignored, not in repo — no credentials stored)
.env.example             Template — copy to .env for Docker's PROTECT_HOST
requirements.txt
Dockerfile              Option B install (see Setup)
docker-compose.yml       Option B install, with Compose
.dockerignore
static/
  index.html           Main page (known/unknown grids, group detail, create person)
  recognize.html        Local face-recognition page (unknowns vs. known people)
  cluster.html            Local clustering page (unknowns vs. each other)
  common.js              Shared frontend utilities (fetch wrapper, card rendering, etc.)
  app.js                Main page logic
  recognize.js           Recognition page logic
  cluster.js               Clustering page logic
  style.css
```
