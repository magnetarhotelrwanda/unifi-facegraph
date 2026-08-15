const logoutBtn = document.getElementById("logout-btn");
const runBtn = document.getElementById("run-btn");
const progressArea = document.getElementById("progress-area");
const progressText = document.getElementById("progress-text");
const resultsSection = document.getElementById("results-section");
const resultsContainer = document.getElementById("results-container");
const resultsSelectedCountEl = document.getElementById("results-selected-count");
const approveSelectedBtn = document.getElementById("approve-selected-btn");
const approveAllBtn = document.getElementById("approve-all-btn");
const noResultsSection = document.getElementById("no-results-section");
const noResultsText = document.getElementById("no-results-text");
const lowConfidenceSection = document.getElementById("low-confidence-section");
const lowConfidenceContainer = document.getElementById("low-confidence-container");
const lowConfidenceCountEl = document.getElementById("low-confidence-count");
const lowConfidenceSelectedCountEl = document.getElementById("low-confidence-selected-count");
const lowConfidenceApproveSelectedBtn = document.getElementById("low-confidence-approve-selected-btn");
const rangeStartInput = document.getElementById("range-start");
const rangeEndInput = document.getElementById("range-end");
const rangeAllCheckbox = document.getElementById("range-all");
const matchThresholdInput = document.getElementById("match-threshold");
const thresholdValueEl = document.getElementById("threshold-value");

let recognitionResults = []; // [{ group, matches: [...] }]
let lowConfidenceResults = [];
const resultsSelected = new Set(); // objectIds currently selected
const lowConfidenceSelected = new Set();
const objectIdToGroupId = new Map();
const lowConfIdToGroupId = new Map();
let pollTimer = null;

matchThresholdInput.addEventListener("input", () => {
  thresholdValueEl.textContent = `${matchThresholdInput.value}%`;
});

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

function buildPersonBlock(group, matches, selectedSet, onToggle, onSelectAll) {
  const block = document.createElement("div");
  block.className = "person-block";

  const header = document.createElement("div");
  header.className = "person-block-header";

  const img = document.createElement("img");
  img.className = "avatar person-block-avatar";
  img.src = `/api/group-image/${encodeURIComponent(group.id)}`;
  img.alt = group.name || group.matchedName || "Known face";
  img.onerror = () => img.replaceWith(makeAvatarFallback(group.name || group.matchedName));

  const titleWrap = document.createElement("div");
  titleWrap.className = "person-block-title";
  const h2 = document.createElement("h2");
  h2.textContent = group.name || group.matchedName || "(unnamed)";
  const countSpan = document.createElement("span");
  countSpan.className = "hint";
  countSpan.textContent = `${matches.length} suggested match${matches.length === 1 ? "" : "es"}`;
  titleWrap.appendChild(h2);
  titleWrap.appendChild(countSpan);

  const selectAllBtn = document.createElement("button");
  selectAllBtn.className = "secondary";
  selectAllBtn.textContent = "Select all";
  selectAllBtn.addEventListener("click", () => {
    for (const m of matches) selectedSet.add(m.objectId);
    onSelectAll();
  });

  header.appendChild(img);
  header.appendChild(titleWrap);
  header.appendChild(selectAllBtn);

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const face of matches) {
    grid.appendChild(createFaceCard(face, selectedSet, onToggle));
  }

  block.appendChild(header);
  block.appendChild(grid);
  return block;
}

function updateResultsSelectedCount() {
  resultsSelectedCountEl.textContent = resultsSelected.size;
  approveSelectedBtn.disabled = resultsSelected.size === 0;
}

function updateLowConfidenceSelectedCount() {
  lowConfidenceSelectedCountEl.textContent = lowConfidenceSelected.size;
  lowConfidenceApproveSelectedBtn.disabled = lowConfidenceSelected.size === 0;
}

function updateNoResultsVisibility() {
  const nothing = recognitionResults.length === 0 && lowConfidenceResults.length === 0;
  noResultsSection.classList.toggle("hidden", !nothing);
  if (nothing) noResultsText.textContent = "No suggested matches found.";
}

function renderResults(results) {
  resultsContainer.innerHTML = "";
  objectIdToGroupId.clear();

  if (!results || results.length === 0) {
    resultsSection.classList.add("hidden");
  } else {
    resultsSection.classList.remove("hidden");
    for (const { group, matches } of results) {
      for (const m of matches) objectIdToGroupId.set(m.objectId, group.id);
      resultsContainer.appendChild(
        buildPersonBlock(group, matches, resultsSelected, updateResultsSelectedCount, () => renderResults(recognitionResults))
      );
    }
  }
  updateResultsSelectedCount();
}

function renderLowConfidence(results) {
  lowConfidenceContainer.innerHTML = "";
  lowConfIdToGroupId.clear();
  let total = 0;

  if (!results || results.length === 0) {
    lowConfidenceSection.classList.add("hidden");
  } else {
    lowConfidenceSection.classList.remove("hidden");
    for (const { group, matches } of results) {
      total += matches.length;
      for (const m of matches) lowConfIdToGroupId.set(m.objectId, group.id);
      lowConfidenceContainer.appendChild(
        buildPersonBlock(group, matches, lowConfidenceSelected, updateLowConfidenceSelectedCount, () =>
          renderLowConfidence(lowConfidenceResults)
        )
      );
    }
  }
  lowConfidenceCountEl.textContent = `(${total})`;
  updateLowConfidenceSelectedCount();
}

async function approveObjectIds(objectIds, idMap) {
  const byGroup = new Map();
  for (const id of objectIds) {
    const groupId = idMap.get(id);
    if (!groupId) continue;
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(id);
  }
  for (const [groupId, ids] of byGroup) {
    await fetchJSON("/api/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectIds: ids, groupId }),
    });
  }
}

function removeApprovedFromResults(objectIds) {
  const approvedSet = new Set(objectIds);
  recognitionResults = recognitionResults
    .map((r) => ({ group: r.group, matches: r.matches.filter((m) => !approvedSet.has(m.objectId)) }))
    .filter((r) => r.matches.length > 0);
  for (const id of objectIds) resultsSelected.delete(id);
  renderResults(recognitionResults);
  updateNoResultsVisibility();
}

function removeApprovedFromLowConfidence(objectIds) {
  const approvedSet = new Set(objectIds);
  lowConfidenceResults = lowConfidenceResults
    .map((r) => ({ group: r.group, matches: r.matches.filter((m) => !approvedSet.has(m.objectId)) }))
    .filter((r) => r.matches.length > 0);
  for (const id of objectIds) lowConfidenceSelected.delete(id);
  renderLowConfidence(lowConfidenceResults);
  updateNoResultsVisibility();
}

async function handleApprove(objectIds, idMap, removeFn, confirmMessage) {
  if (objectIds.length === 0) return;
  if (confirmMessage && !confirm(confirmMessage)) return;

  approveSelectedBtn.disabled = true;
  approveAllBtn.disabled = true;
  lowConfidenceApproveSelectedBtn.disabled = true;
  try {
    await approveObjectIds(objectIds, idMap);
    removeFn(objectIds);
    showToast(`Approved ${objectIds.length} match(es).`);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      window.location.href = "/";
      return;
    }
    showToast(err.message, true);
  } finally {
    approveAllBtn.disabled = false;
    approveSelectedBtn.disabled = resultsSelected.size === 0;
    lowConfidenceApproveSelectedBtn.disabled = lowConfidenceSelected.size === 0;
  }
}

approveSelectedBtn.addEventListener("click", () => {
  handleApprove(Array.from(resultsSelected), objectIdToGroupId, removeApprovedFromResults);
});

approveAllBtn.addEventListener("click", () => {
  const allIds = Array.from(objectIdToGroupId.keys());
  handleApprove(allIds, objectIdToGroupId, removeApprovedFromResults, `Approve all ${allIds.length} suggested matches across all people?`);
});

lowConfidenceApproveSelectedBtn.addEventListener("click", () => {
  handleApprove(Array.from(lowConfidenceSelected), lowConfIdToGroupId, removeApprovedFromLowConfidence);
});

// --- Run + poll ----------------------------------------------------------

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
    const status = await fetchJSON("/api/recognize/status");
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
    showToast(status.error || "Recognition failed.", true);
    return;
  }

  if (status.status === "done") {
    await loadCameras();
    recognitionResults = status.results || [];
    lowConfidenceResults = status.lowConfidenceResults || [];
    renderResults(recognitionResults);
    renderLowConfidence(lowConfidenceResults);
    updateNoResultsVisibility();
    if (status.error) {
      showToast(status.error, true);
    }
  }
}

runBtn.addEventListener("click", async () => {
  const range = computeDateRangeMs();
  if (!range) {
    showToast('Pick a valid date range, or check "process all".', true);
    return;
  }

  runBtn.disabled = true;
  resultsSection.classList.add("hidden");
  lowConfidenceSection.classList.add("hidden");
  noResultsSection.classList.add("hidden");
  progressArea.classList.remove("hidden");
  progressText.textContent = "Starting…";
  try {
    await fetchJSON("/api/recognize/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: range.start,
        end: range.end,
        matchThreshold: Number(matchThresholdInput.value) / 100,
      }),
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

// --- Bootstrap -------------------------------------------------------------

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
    const status = await fetchJSON("/api/recognize/status");
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
