const knownGrid = document.getElementById("known-grid");
const unknownGrid = document.getElementById("unknown-grid");
const knownCountEl = document.getElementById("known-count");
const unknownCountEl = document.getElementById("unknown-count");
const selectedCountEl = document.getElementById("selected-count");
const statusLine = document.getElementById("status-line");
const recognizeLink = document.getElementById("recognize-link");
const clusterLink = document.getElementById("cluster-link");
const refreshBtn = document.getElementById("refresh-btn");
const logoutBtn = document.getElementById("logout-btn");
const loginSection = document.getElementById("login-section");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const loginHint = document.getElementById("login-hint");
const loginCredentialsFields = document.getElementById("login-credentials-fields");
const loginMfaField = document.getElementById("login-mfa-field");
const loginMfaInput = document.getElementById("login-mfa");
const appContent = document.getElementById("app-content");
const knownSection = document.getElementById("known-section");
const unknownSection = document.getElementById("unknown-section");
const createPersonNameInput = document.getElementById("create-person-name");
const createPersonBtn = document.getElementById("create-person-btn");
const groupDetailSection = document.getElementById("group-detail-section");
const groupDetailBackBtn = document.getElementById("group-detail-back");
const groupDetailDeleteBtn = document.getElementById("group-detail-delete");
const groupDetailAvatar = document.getElementById("group-detail-avatar");
const groupDetailName = document.getElementById("group-detail-name");
const groupDetailMeta = document.getElementById("group-detail-meta");
const groupDetailGrid = document.getElementById("group-detail-grid");
const groupDetailSelectedCountEl = document.getElementById("group-detail-selected-count");
const groupDetailUnassignBtn = document.getElementById("group-detail-unassign");
const groupDetailReassignGrid = document.getElementById("group-detail-reassign-grid");
const unknownPagesTop = document.getElementById("unknown-pages-top");
const unknownPagesBottom = document.getElementById("unknown-pages-bottom");

// Held only in memory for the duration of a login attempt (needed to
// resubmit alongside a 2FA code); never written to disk or localStorage.
let pendingCredentials = null;

let groups = [];
let unknownFaces = []; // the current page only, one entry per unmatched face thumbnail
const selected = new Set(); // objectIds currently selected

// The server reads the full unknown history in the background and serves it
// in pages; these mirror its /api/unknowns summary.
let unknownPage = 1;
let unknownPageReady = false;
let unknownSummary = { total: 0, totalPages: 0, pageSize: 0, loading: false, error: null };
let unknownPollTimer = null;
const UNKNOWN_POLL_MS = 2000;

let currentGroup = null;
let groupDetailFaces = [];
const groupDetailSelected = new Set();

function setStatus(text) {
  statusLine.textContent = text;
}

// --- Known faces ---------------------------------------------------------

function renderKnownGrid() {
  knownGrid.innerHTML = "";
  knownCountEl.textContent = `(${groups.length})`;

  if (groups.length === 0) {
    knownGrid.innerHTML = '<div class="empty-state">No known face groups found.</div>';
    return;
  }

  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "card known-card";
    card.dataset.groupId = group.id;

    const img = document.createElement("img");
    img.className = "avatar";
    img.src = `/api/group-image/${encodeURIComponent(group.id)}`;
    img.alt = group.name || group.matchedName || "Known face";
    img.onerror = () => {
      img.replaceWith(makeAvatarFallback(group.name || group.matchedName));
    };

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = group.name || group.matchedName || "(unnamed)";

    const meta = document.createElement("div");
    meta.className = "meta";
    const detCount = group.detectionsCount ?? "—";
    const conf = formatPct(group.metadata?.averageConfidence);
    meta.textContent = `${detCount} detections · ${conf} avg conf`;

    card.appendChild(img);
    card.appendChild(name);
    card.appendChild(meta);
    card.addEventListener("click", () => onKnownCardClick(group));

    knownGrid.appendChild(card);
  }
}

function onKnownCardClick(group) {
  if (selected.size === 0) {
    openGroupDetail(group);
    return;
  }
  assignSelectedTo(group);
}

async function assignSelectedTo(group) {
  const objectIds = Array.from(selected);
  const cardsToRemove = objectIds
    .map((id) => unknownGrid.querySelector(`[data-object-id="${cssEscape(id)}"]`))
    .filter(Boolean);
  cardsToRemove.forEach((c) => c.classList.add("assigning"));

  try {
    await fetchJSON("/api/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectIds, groupId: group.id }),
    });

    removeUnknownFacesLocally(selected);
    showToast(`Assigned ${objectIds.length} detection(s) to ${group.name || group.matchedName}.`);
  } catch (err) {
    cardsToRemove.forEach((c) => c.classList.remove("assigning"));
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    showToast(err.message, true);
  }
}

// --- Unknown detections ---------------------------------------------------

function renderUnknownGrid() {
  unknownGrid.innerHTML = "";
  renderUnknownCount();

  if (!unknownPageReady) {
    unknownGrid.innerHTML = '<div class="empty-state">Loading this page from the controller…</div>';
    return;
  }
  if (unknownFaces.length === 0) {
    const msg = unknownSummary.total === 0 ? "No unknown detections. Nice and tidy." : "Nothing left on this page.";
    unknownGrid.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  for (const face of unknownFaces) {
    unknownGrid.appendChild(createFaceCard(face, selected, updateSelectedCount));
  }
}

function renderUnknownCount() {
  const total = unknownSummary.total.toLocaleString();
  unknownCountEl.textContent = unknownSummary.loading ? `(${total} so far, still loading…)` : `(${total})`;
}

function renderUnknownPagination() {
  for (const nav of [unknownPagesTop, unknownPagesBottom]) {
    nav.innerHTML = "";
    const knownPages = Math.max(unknownSummary.totalPages, unknownPage);
    if (knownPages <= 1 && !unknownSummary.loading) continue;

    const addButton = (label, page, { current = false, disabled = false } = {}) => {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (current ? " current" : "");
      btn.textContent = label;
      btn.disabled = disabled || current;
      if (current) btn.setAttribute("aria-current", "page");
      btn.addEventListener("click", () => goToUnknownPage(page));
      nav.appendChild(btn);
    };

    addButton("‹ Prev", unknownPage - 1, { disabled: unknownPage <= 1 });
    for (let p = 1; p <= knownPages; p++) {
      addButton(String(p), p, { current: p === unknownPage });
    }
    if (unknownSummary.loading) {
      const more = document.createElement("span");
      more.className = "page-loading";
      more.textContent = "more loading…";
      nav.appendChild(more);
    }
    addButton("Next ›", unknownPage + 1, {
      disabled: unknownPage >= unknownSummary.totalPages,
    });
  }
}

function removeUnknownFacesLocally(objectIds) {
  const ids = new Set(objectIds);
  const before = unknownFaces.length;
  unknownFaces = unknownFaces.filter((f) => !ids.has(f.objectId));
  unknownSummary.total = Math.max(0, unknownSummary.total - (before - unknownFaces.length));
  selected.clear();
  renderUnknownGrid();
  updateSelectedCount();
}

async function goToUnknownPage(page) {
  if (page < 1 || page === unknownPage) return;
  unknownPage = page;
  selected.clear();
  updateSelectedCount();
  await loadUnknownPage();
  unknownSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadUnknownPage() {
  const requestedPage = unknownPage;
  const res = await fetchJSON(`/api/unknowns?page=${requestedPage}`);
  if (requestedPage !== unknownPage) return; // user clicked another tab meanwhile

  applyUnknownSummary(res);
  unknownPageReady = res.ready;
  unknownFaces = res.ready ? res.faces : [];
  if (res.ready && unknownFaces.length === 0 && unknownPage > Math.max(1, res.totalPages)) {
    // Page no longer exists (e.g. faces were assigned) -- go to the last one.
    unknownPage = Math.max(1, res.totalPages);
    return loadUnknownPage();
  }
  renderUnknownGrid();
  renderUnknownPagination();
  updateStatusLine();
  scheduleUnknownPoll();
}

function applyUnknownSummary(summary) {
  const hadError = unknownSummary.error;
  unknownSummary = {
    total: summary.total,
    totalPages: summary.totalPages,
    pageSize: summary.pageSize,
    loading: summary.loading,
    error: summary.error,
  };
  if (summary.error && summary.error !== hadError) {
    showToast(`Stopped loading unknown faces: ${summary.error}. Use Refresh to try again.`, true);
  }
}

function scheduleUnknownPoll() {
  clearTimeout(unknownPollTimer);
  if (!unknownSummary.loading) return;
  unknownPollTimer = setTimeout(pollUnknowns, UNKNOWN_POLL_MS);
}

async function pollUnknowns() {
  try {
    if (!unknownPageReady) {
      await loadUnknownPage(); // reschedules itself
      return;
    }
    // Current page is already on screen -- just grow the tabs, without
    // re-rendering the grid (which would drop the user's selection).
    applyUnknownSummary(await fetchJSON("/api/unknowns/status"));
    renderUnknownCount();
    renderUnknownPagination();
    updateStatusLine();
    scheduleUnknownPoll();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    scheduleUnknownPoll();
  }
}

function updateStatusLine() {
  const total = unknownSummary.total.toLocaleString();
  const suffix = unknownSummary.loading ? " (loading…)" : "";
  setStatus(`Loaded ${groups.length} known / ${total} unknown${suffix}`);
}

function updateSelectedCount() {
  selectedCountEl.textContent = selected.size;
  createPersonBtn.disabled = selected.size === 0;
}

// --- Data loading ----------------------------------------------------------

function extractFaceThumbnails(events, predicate) {
  const faces = [];
  for (const event of events || []) {
    const thumbnails = event.metadata?.detectedThumbnails || [];
    for (const t of thumbnails) {
      if (t.type !== "face") continue; // events also carry "person" thumbnails
      if (!predicate(t)) continue;
      faces.push({
        objectId: t.objectId,
        croppedId: t.croppedId,
        groupId: t.group?.id, // top-level field, not nested under attributes
        confidence: t.confidence,
        qualityScore: t.attributes?.qualityScore,
        camera: event.camera || event.cameraId || event.cameraName,
        timestamp: event.start || event.timestamp || event.eventStart,
      });
    }
  }
  return faces;
}

function flattenGroupFaces(events, groupId) {
  return extractFaceThumbnails(events, (t) => t.group?.id === groupId);
}

async function loadGroups() {
  const groupsRes = await fetchJSON("/api/groups");
  groups = groupsRes.groups || groupsRes.data || (Array.isArray(groupsRes) ? groupsRes : []);
  renderKnownGrid();
}

async function loadAll() {
  setStatus("Loading…");
  selected.clear();
  updateSelectedCount();
  try {
    await Promise.all([loadGroups(), loadCameras()]);
    await loadUnknownPage();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    setStatus("");
    showToast(`Failed to load: ${err.message}`, true);
  }
}

// --- Auth -------------------------------------------------------------

function resetToCredentialsStep() {
  pendingCredentials = null;
  loginMfaField.classList.add("hidden");
  loginMfaInput.value = "";
  loginCredentialsFields.classList.remove("hidden");
  loginHint.textContent =
    "Credentials are sent directly to your controller and are never saved to disk — only the resulting session is kept in memory while this server is running.";
  loginSubmit.textContent = "Log in";
}

function showLoginScreen(message) {
  clearTimeout(unknownPollTimer);
  appContent.classList.add("hidden");
  refreshBtn.classList.add("hidden");
  logoutBtn.classList.add("hidden");
  recognizeLink.classList.add("hidden");
  clusterLink.classList.add("hidden");
  loginSection.classList.remove("hidden");
  resetToCredentialsStep();
  setStatus("");
  if (message) {
    loginError.textContent = message;
    loginError.classList.remove("hidden");
  } else {
    loginError.classList.add("hidden");
  }
}

function showAppScreen() {
  loginSection.classList.add("hidden");
  appContent.classList.remove("hidden");
  refreshBtn.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  recognizeLink.classList.remove("hidden");
  clusterLink.classList.remove("hidden");
  // Always land back on the main grids, not a stale group-detail view left
  // over from before a session expiry.
  currentGroup = null;
  groupDetailSection.classList.add("hidden");
  knownSection.classList.remove("hidden");
  unknownSection.classList.remove("hidden");
}

async function checkAuthAndLoad() {
  try {
    const status = await fetchJSON("/api/auth/status");
    if (status.authenticated) {
      showAppScreen();
      await loadAll();
    } else {
      showLoginScreen();
    }
  } catch (err) {
    showLoginScreen(err.message);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const usernameInput = document.getElementById("login-username");
  const passwordInput = document.getElementById("login-password");

  const inMfaStep = pendingCredentials !== null;
  const credentials = inMfaStep
    ? pendingCredentials
    : { username: usernameInput.value, password: passwordInput.value };
  const payload = inMfaStep ? { ...credentials, token: loginMfaInput.value } : credentials;

  loginSubmit.disabled = true;
  loginError.classList.add("hidden");
  try {
    await fetchJSON("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    passwordInput.value = "";
    resetToCredentialsStep();
    showAppScreen();
    await loadAll();
  } catch (err) {
    if (err instanceof MfaRequiredError) {
      pendingCredentials = credentials; // held in memory only, for this login attempt
      loginCredentialsFields.classList.add("hidden");
      loginMfaField.classList.remove("hidden");
      loginMfaInput.value = "";
      loginHint.textContent = "Enter the 2FA code from your authenticator app.";
      loginSubmit.textContent = "Verify code";
      loginMfaInput.focus();
    } else {
      loginError.textContent = err.message;
      loginError.classList.remove("hidden");
    }
  } finally {
    loginSubmit.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await fetchJSON("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore -- we're logging out regardless
  }
  showLoginScreen();
});

// --- Group detail (view / unassign / reassign) -----------------------

async function openGroupDetail(group) {
  currentGroup = group;
  groupDetailSelected.clear();
  knownSection.classList.add("hidden");
  unknownSection.classList.add("hidden");
  groupDetailSection.classList.remove("hidden");

  groupDetailName.textContent = group.name || group.matchedName || "(unnamed)";
  groupDetailMeta.textContent = `${group.detectionsCount ?? "—"} detections · ${formatPct(group.metadata?.averageConfidence)} avg conf`;
  groupDetailAvatar.src = `/api/group-image/${encodeURIComponent(group.id)}`;
  groupDetailAvatar.onerror = () => {
    groupDetailAvatar.replaceWith(makeAvatarFallback(group.name || group.matchedName));
  };

  renderReassignGrid();
  await loadGroupDetail();
}

function closeGroupDetail() {
  currentGroup = null;
  groupDetailSection.classList.add("hidden");
  knownSection.classList.remove("hidden");
  unknownSection.classList.remove("hidden");
  loadAll(); // resync counts/grids in case anything was unassigned or reassigned
}

async function loadGroupDetail() {
  groupDetailGrid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    let url = `/api/groups/${encodeURIComponent(currentGroup.id)}/detections`;
    if (currentGroup.firstDetectedAt && currentGroup.lastDetectedAt) {
      const params = new URLSearchParams({
        start: currentGroup.firstDetectedAt,
        end: currentGroup.lastDetectedAt,
      });
      url += `?${params}`;
    }
    const res = await fetchJSON(url);
    const events = res.events || res.data || (Array.isArray(res) ? res : []);
    groupDetailFaces = flattenGroupFaces(events, currentGroup.id);
    renderGroupDetailGrid();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    groupDetailGrid.innerHTML = "";
    showToast(`Failed to load detections: ${err.message}`, true);
  }
}

function renderGroupDetailGrid() {
  groupDetailGrid.innerHTML = "";
  if (groupDetailFaces.length === 0) {
    groupDetailGrid.innerHTML = '<div class="empty-state">No detections found for this person.</div>';
  } else {
    for (const face of groupDetailFaces) {
      groupDetailGrid.appendChild(createFaceCard(face, groupDetailSelected, updateGroupDetailSelectedCount));
    }
  }
  updateGroupDetailSelectedCount();
}

function updateGroupDetailSelectedCount() {
  groupDetailSelectedCountEl.textContent = groupDetailSelected.size;
  groupDetailUnassignBtn.disabled = groupDetailSelected.size === 0;
}

function renderReassignGrid() {
  groupDetailReassignGrid.innerHTML = "";
  const others = groups.filter((g) => g.id !== currentGroup.id);
  if (others.length === 0) {
    groupDetailReassignGrid.innerHTML = '<div class="empty-state">No other known people yet.</div>';
    return;
  }
  for (const group of others) {
    const card = document.createElement("div");
    card.className = "card known-card";

    const img = document.createElement("img");
    img.className = "avatar";
    img.src = `/api/group-image/${encodeURIComponent(group.id)}`;
    img.alt = group.name || group.matchedName || "Known face";
    img.onerror = () => img.replaceWith(makeAvatarFallback(group.name || group.matchedName));

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = group.name || group.matchedName || "(unnamed)";

    card.appendChild(img);
    card.appendChild(name);
    card.addEventListener("click", () => reassignSelectedTo(group));

    groupDetailReassignGrid.appendChild(card);
  }
}

async function reassignSelectedTo(targetGroup) {
  if (groupDetailSelected.size === 0) {
    showToast("Select one or more detections first.");
    return;
  }
  const objectIds = Array.from(groupDetailSelected);
  try {
    await fetchJSON("/api/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectIds, groupId: targetGroup.id }),
    });
    groupDetailFaces = groupDetailFaces.filter((f) => !groupDetailSelected.has(f.objectId));
    groupDetailSelected.clear();
    renderGroupDetailGrid();
    showToast(`Reassigned ${objectIds.length} detection(s) to ${targetGroup.name || targetGroup.matchedName}.`);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    showToast(err.message, true);
  }
}

groupDetailUnassignBtn.addEventListener("click", async () => {
  if (groupDetailSelected.size === 0) return;
  const objectIds = Array.from(groupDetailSelected);
  groupDetailUnassignBtn.disabled = true;
  try {
    await fetchJSON("/api/unassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectIds }),
    });
    groupDetailFaces = groupDetailFaces.filter((f) => !groupDetailSelected.has(f.objectId));
    groupDetailSelected.clear();
    renderGroupDetailGrid();
    showToast(`Unassigned ${objectIds.length} detection(s).`);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    showToast(err.message, true);
  } finally {
    groupDetailUnassignBtn.disabled = groupDetailSelected.size === 0;
  }
});

groupDetailBackBtn.addEventListener("click", closeGroupDetail);

groupDetailDeleteBtn.addEventListener("click", async () => {
  const name = currentGroup.name || currentGroup.matchedName || "this person";
  if (!confirm(`Delete "${name}"? This removes the known person entirely (their past detections become unknown again). This can't be undone.`)) {
    return;
  }
  const groupId = currentGroup.id;
  groupDetailDeleteBtn.disabled = true;
  try {
    await fetchJSON(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    showToast(`Deleted "${name}".`);
    currentGroup = null; // avoid closeGroupDetail's resync racing a re-render against the deleted group
    groupDetailSection.classList.add("hidden");
    knownSection.classList.remove("hidden");
    unknownSection.classList.remove("hidden");
    await loadAll();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    showToast(err.message, true);
  } finally {
    groupDetailDeleteBtn.disabled = false;
  }
});

// --- Create new person from selected unknown faces ---------------------

createPersonBtn.addEventListener("click", async () => {
  const name = createPersonNameInput.value.trim();
  if (!name) {
    showToast("Enter a name first.", true);
    return;
  }
  if (selected.size === 0) return;

  const objectIds = Array.from(selected);
  const anchor = unknownFaces.find((f) => selected.has(f.objectId) && f.groupId);
  if (!anchor) {
    showToast("Can't create a new person from these detections (missing group id).", true);
    return;
  }

  createPersonBtn.disabled = true;
  try {
    await fetchJSON("/api/create-person", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorGroupId: anchor.groupId, objectIds, name }),
    });
    removeUnknownFacesLocally(objectIds);
    createPersonNameInput.value = "";
    showToast(`Created "${name}" from ${objectIds.length} detection(s).`);
    await loadGroups();
    updateStatusLine();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
    showToast(err.message, true);
  } finally {
    createPersonBtn.disabled = selected.size === 0;
  }
});

refreshBtn.addEventListener("click", async () => {
  // Re-reads the whole unknown history from the controller, from page 1.
  try {
    await fetchJSON("/api/unknowns/refresh", { method: "POST" });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLoginScreen("Your session expired. Please log in again.");
      return;
    }
  }
  unknownPage = 1;
  await loadAll();
});
checkAuthAndLoad();
