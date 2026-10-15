// Shared across index.html (app.js) and recognize.html (recognize.js).
// Plain globals, no build step / no modules -- load this before the
// page-specific script.

const toast = document.getElementById("toast");

function showToast(message, isError) {
  toast.textContent = message;
  toast.className = "toast" + (isError ? " error" : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.add("hidden");
  }, 4000);
}

class AuthRequiredError extends Error {}
class MfaRequiredError extends Error {}

async function fetchJSON(url, options) {
  const res = await fetch(url, { cache: "no-store", ...options });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.mfaRequired) {
    throw new MfaRequiredError(body.error || "2FA code required");
  }
  if (res.status === 401 && body.requiresLogin) {
    throw new AuthRequiredError(body.error || "Not logged in");
  }
  if (!res.ok) {
    throw new Error(body.error || `Request to ${url} failed (${res.status})`);
  }
  return body;
}

function formatTimestamp(ms) {
  if (!ms) return "—";
  try {
    return new Date(Number(ms)).toLocaleString();
  } catch {
    return "—";
  }
}

function formatPct(value) {
  if (value === undefined || value === null) return "—";
  // API values observed as 0-1 or 0-100 depending on field; normalize.
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function cssEscape(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function makeAvatarFallback(label) {
  const div = document.createElement("div");
  div.className = "avatar-fallback";
  div.textContent = (label || "?").trim().charAt(0).toUpperCase() || "?";
  return div;
}

function makeThumbFallback() {
  const div = document.createElement("div");
  div.className = "avatar-fallback";
  div.textContent = "\u{1F464}";
  return div;
}

let cameraNames = new Map(); // camera id -> friendly name

async function loadCameras() {
  // Camera list rarely changes -- fetch once and cache rather than
  // re-fetching on every load.
  if (cameraNames.size > 0) return;
  try {
    const res = await fetchJSON("/api/cameras");
    const cameras = res.cameras || [];
    cameraNames = new Map(cameras.map((c) => [c.id, c.name]));
  } catch {
    // Non-fatal -- cards just fall back to showing the raw camera id.
  }
}

function createFaceCard(face, selectedSet, onToggle) {
  const card = document.createElement("div");
  card.className = "card unknown-card";
  card.dataset.objectId = face.objectId;
  if (selectedSet.has(face.objectId)) card.classList.add("selected");

  const meta = document.createElement("div");
  meta.className = "unknown-meta";
  meta.innerHTML = `
    ${face.score !== undefined ? `<div class="row match-score"><span class="label">Match:</span> ${formatPct(face.score)}</div>` : ""}
    <div class="row"><span class="label">Confidence:</span> ${formatPct(face.confidence)}</div>
    <div class="row"><span class="label">Quality:</span> ${formatPct(face.qualityScore)}</div>
    <div class="row"><span class="label">Camera:</span> ${cameraNames.get(face.camera) || face.camera || "—"}</div>
    <div class="row"><span class="label">Time:</span> ${formatTimestamp(face.timestamp)}</div>
  `;

  if (face.croppedId) {
    const img = document.createElement("img");
    img.className = "detection-thumb";
    img.src = `/api/detection-image/${encodeURIComponent(face.croppedId)}`;
    img.alt = "Face detection";
    img.loading = "lazy";
    img.onerror = () => {
      img.replaceWith(makeThumbFallback());
    };
    card.appendChild(img);
  } else {
    card.appendChild(makeThumbFallback());
  }
  card.appendChild(meta);

  card.addEventListener("click", () => {
    if (selectedSet.has(face.objectId)) {
      selectedSet.delete(face.objectId);
      card.classList.remove("selected");
    } else {
      selectedSet.add(face.objectId);
      card.classList.add("selected");
    }
    onToggle();
  });

  return card;
}
