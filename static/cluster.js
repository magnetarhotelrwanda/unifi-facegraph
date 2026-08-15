const logoutBtn = document.getElementById("logout-btn");
const runBtn = document.getElementById("run-btn");
const progressArea = document.getElementById("progress-area");
const progressText = document.getElementById("progress-text");
const rangeStartInput = document.getElementById("range-start");
const rangeEndInput = document.getElementById("range-end");
const rangeAllCheckbox = document.getElementById("range-all");
const clusterControlsSection = document.getElementById("cluster-controls-section");
const clusterThresholdInput = document.getElementById("cluster-threshold");
const thresholdValueEl = document.getElementById("threshold-value");
const clustersSection = document.getElementById("clusters-section");
const clustersContainer = document.getElementById("clusters-container");
const clustersCountEl = document.getElementById("clusters-count");
const ungroupedSection = document.getElementById("ungrouped-section");
const ungroupedGrid = document.getElementById("ungrouped-grid");
const ungroupedCountEl = document.getElementById("ungrouped-count");
const noResultsSection = document.getElementById("no-results-section");
const noResultsText = document.getElementById("no-results-text");

let allFaces = []; // every embedded unknown face from the last computed run
let knownGroups = []; // for the "assign to existing person" strip
let pollTimer = null;

// --- Date range (same pattern as recognize.js) ------------------------

rangeAllCheckbox.addEventListener("change", () => {
  rangeStartInput.disabled = rangeAllCheckbox.checked;
  rangeEndInput.disabled = rangeAllCheckbox.checked;
});

function setDefaultDateRange() {
  const iso = new Date().toISOString().slice(0, 10);
  rangeStartInput.value = iso;
  rangeEndInput.value = iso;
}

function computeDateRangeMs() {
  if (rangeAllCheckbox.checked) {
    return { start: 0, end: Date.now() };
  }
  const startDate = rangeStartInput.value ? new Date(`${rangeStartInput.value}T00:00:00`) : null;
  const endDate = rangeEndInput.value ? new Date(`${rangeEndInput.value}T23:59:59.999`) : null;
  if (!startDate || !endDate || startDate > endDate) return null;
  return { start: startDate.getTime(), end: endDate.getTime() };
}

// --- Clustering (client-side, so the threshold slider is instant) ------

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // InsightFace embeddings are already L2-normalized
}

function clusterFaces(faces, threshold) {
  const n = faces.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(faces[i].embedding, faces[j].embedding) >= threshold) {
        union(i, j);
      }
    }
  }

  const groupsByRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(faces[i]);
  }

  const clusters = [];
  const ungrouped = [];
  for (const members of groupsByRoot.values()) {
    if (members.length >= 2) clusters.push(members);
    else ungrouped.push(members[0]);
  }
  clusters.sort((a, b) => b.length - a.length);
  return { clusters, ungrouped };
}

function recluster() {
  const threshold = Number(clusterThresholdInput.value) / 100;
  const { clusters, ungrouped } = clusterFaces(allFaces, threshold);
  renderClusters(clusters);
  renderUngrouped(ungrouped);

  const nothing = allFaces.length === 0;
  noResultsSection.classList.toggle("hidden", !nothing);
  if (nothing) noResultsText.textContent = "No unknown faces to compare (or none had a detectable face).";
}

clusterThresholdInput.addEventListener("input", () => {
  thresholdValueEl.textContent = `${clusterThresholdInput.value}%`;
  recluster();
});

// --- Rendering -----------------------------------------------------------

function renderClusters(clusters) {
  clustersContainer.innerHTML = "";
  clustersCountEl.textContent = `(${clusters.length})`;

  if (clusters.length === 0) {
    clustersSection.classList.add("hidden");
    return;
  }
  clustersSection.classList.remove("hidden");

  clusters.forEach((members, idx) => {
    clustersContainer.appendChild(buildClusterBlock(members, idx + 1));
  });
}

function renderUngrouped(faces) {
  ungroupedGrid.innerHTML = "";
  ungroupedCountEl.textContent = `(${faces.length})`;

  if (faces.length === 0) {
    ungroupedSection.classList.add("hidden");
    return;
  }
  ungroupedSection.classList.remove("hidden");

  const dummySet = new Set(); // ungrouped faces aren't actionable here, just shown for visibility
  for (const face of faces) {
    ungroupedGrid.appendChild(createFaceCard(face, dummySet, () => {}));
  }
}

function buildClusterBlock(members, index) {
  const block = document.createElement("div");
  block.className = "person-block cluster-block";

  // Pre-selected by default (opt-out model): clicking a card excludes it
  // from the batch action instead of requiring an explicit "select all".
  const selected = new Set(members.map((m) => m.objectId));

  const header = document.createElement("div");
  header.className = "person-block-header";
  const titleWrap = document.createElement("div");
  titleWrap.className = "person-block-title";
  const h3 = document.createElement("h3");
  h3.textContent = `Group ${index}`;
  const countSpan = document.createElement("span");
  countSpan.className = "hint";
  countSpan.textContent = `${members.length} faces`;
  titleWrap.appendChild(h3);
  titleWrap.appendChild(countSpan);
  header.appendChild(titleWrap);

  const grid = document.createElement("div");
  grid.className = "grid";
  const selectedCountEl = document.createElement("span");
  const updateSelectedCount = () => {
    selectedCountEl.textContent = `${selected.size} selected`;
  };
  for (const face of members) {
    grid.appendChild(createFaceCard(face, selected, updateSelectedCount));
  }

  const actions = document.createElement("div");
  actions.className = "cluster-actions";

  const selectedHint = document.createElement("p");
  selectedHint.className = "hint";
  selectedHint.appendChild(selectedCountEl);
  updateSelectedCount();

  const createForm = document.createElement("div");
  createForm.className = "create-person-form";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name this group as a new person";
  const nameBtn = document.createElement("button");
  nameBtn.textContent = "Name selected as new person";
  nameBtn.addEventListener("click", () => handleNameCluster(members, selected, nameInput, nameBtn));
  createForm.appendChild(nameInput);
  createForm.appendChild(nameBtn);

  const assignWrap = document.createElement("div");
  assignWrap.className = "cluster-assign-existing";
  const assignHint = document.createElement("p");
  assignHint.className = "hint";
  assignHint.textContent = "Or assign selected to an existing person:";
  const assignGrid = document.createElement("div");
  assignGrid.className = "grid mini-grid";
  for (const group of knownGroups) {
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
    card.addEventListener("click", () => handleAssignCluster(members, selected, group));
    assignGrid.appendChild(card);
  }
  assignWrap.appendChild(assignHint);
  assignWrap.appendChild(assignGrid);

  actions.appendChild(selectedHint);
  actions.appendChild(createForm);
  actions.appendChild(assignWrap);

  block.appendChild(header);
  block.appendChild(grid);
  block.appendChild(actions);
  return block;
}

// --- Actions ---------------------------------------------------------------

function removeFacesFromPool(objectIds) {
  const removedSet = new Set(objectIds);
  allFaces = allFaces.filter((f) => !removedSet.has(f.objectId));
  recluster();
}

async function handleNameCluster(members, selected, nameInput, nameBtn) {
  const name = nameInput.value.trim();
  if (!name) {
    showToast("Enter a name first.", true);
    return;
  }
  const objectIds = members.filter((m) => selected.has(m.objectId)).map((m) => m.objectId);
  if (objectIds.length === 0) {
    showToast("Nothing selected in this group.", true);
    return;
  }
  const anchor = members.find((m) => selected.has(m.objectId) && m.groupId);
  if (!anchor) {
    showToast("Can't create a new person from this group (missing group id).", true);
    return;
  }

  nameBtn.disabled = true;
  try {
    await fetchJSON("/api/create-person", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorGroupId: anchor.groupId, objectIds, name }),
    });
    showToast(`Created "${name}" from ${objectIds.length} face(s).`);
    removeFacesFromPool(objectIds);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
      return;
    }
    showToast(err.message, true);
  } finally {
    nameBtn.disabled = false;
  }
}

async function handleAssignCluster(members, selected, targetGroup) {
  const objectIds = members.filter((m) => selected.has(m.objectId)).map((m) => m.objectId);
  if (objectIds.length === 0) {
    showToast("Nothing selected in this group.", true);
    return;
  }
  try {
    await fetchJSON("/api/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectIds, groupId: targetGroup.id }),
    });
    showToast(`Assigned ${objectIds.length} face(s) to ${targetGroup.name || targetGroup.matchedName}.`);
    removeFacesFromPool(objectIds);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
      return;
    }
    showToast(err.message, true);
  }
}

// --- Run + poll ------------------------------------------------------------

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollStatus, 1000);
  pollStatus();
}

async function pollStatus() {
  try {
    const status = await fetchJSON("/api/cluster/status");
    await applyStatus(status);
  } catch (err) {
    stopPolling();
    runBtn.disabled = false;
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
      return;
    }
    showToast(err.message, true);
  }
}

async function applyStatus(status) {
  if (status.status === "running") {
    runBtn.disabled = true;
    progressArea.classList.remove("hidden");
    const pct = status.total > 0 ? Math.round((status.current / status.total) * 100) : 0;
    progressText.textContent = `${status.stage || "Working…"} (${status.current}/${status.total}${status.total ? `, ${pct}%` : ""})`;
    return;
  }

  stopPolling();
  runBtn.disabled = false;
  progressArea.classList.add("hidden");

  if (status.status === "error") {
    showToast(status.error || "Clustering failed.", true);
    return;
  }

  if (status.status === "done") {
    await loadCameras();
    allFaces = status.faces || [];
    clusterControlsSection.classList.toggle("hidden", allFaces.length === 0);
    recluster();
  }
}

runBtn.addEventListener("click", async () => {
  const range = computeDateRangeMs();
  if (!range) {
    showToast('Pick a valid date range, or check "process all".', true);
    return;
  }

  runBtn.disabled = true;
  clusterControlsSection.classList.add("hidden");
  clustersSection.classList.add("hidden");
  ungroupedSection.classList.add("hidden");
  noResultsSection.classList.add("hidden");
  progressArea.classList.remove("hidden");
  progressText.textContent = "Starting…";
  try {
    await fetchJSON("/api/cluster/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: range.start, end: range.end }),
    });
    startPolling();
  } catch (err) {
    runBtn.disabled = false;
    progressArea.classList.add("hidden");
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
      return;
    }
    showToast(err.message, true);
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await fetchJSON("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore -- we're logging out regardless
  }
  window.location.href = "/";
});

// --- Bootstrap ---------------------------------------------------------

async function init() {
  try {
    const status = await fetchJSON("/api/auth/status");
    if (!status.authenticated) {
      window.location.href = "/";
      return;
    }
  } catch {
    window.location.href = "/";
    return;
  }

  setDefaultDateRange();
  await loadCameras();

  try {
    const groupsRes = await fetchJSON("/api/groups");
    knownGroups = groupsRes.groups || [];
  } catch {
    // Non-fatal -- "assign to existing person" strip just won't have options.
  }

  try {
    const status = await fetchJSON("/api/cluster/status");
    await applyStatus(status);
    if (status.status === "running") {
      startPolling();
    }
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
    }
  }
}

init();
