const PALETTE = ["#185fa5", "#27500a", "#854f0b", "#791f1f", "#4b2e83", "#0c447c", "#5f5e5a"];
const color = (i) => PALETTE[i % PALETTE.length];

let selectedFile = null;
let pollTimer = null;
let currentProjectId = null;
let currentRunId = null;
let triggerRainbowGenerate = null; // set by buildRainbowFixCard, called automatically after output QA finds errors

const statusBox = document.getElementById("statusBox");
const runStatusEl = document.getElementById("runStatus");
const runIdEl = document.getElementById("runId");
const mainPanel = document.getElementById("mainPanel");
const newProjectBtn = document.getElementById("newProjectBtn");
const projectsListEl = document.getElementById("projectsList");
const projectsToggle = document.getElementById("projectsToggle");
const projectsChevron = document.getElementById("projectsChevron");
const homeLink = document.getElementById("homeLink");

// ── Navigation: projects list, project detail, run dashboard ───────────
async function loadProjectsList() {
  const res = await fetch("/projects");
  const projects = await res.json();
  projectsListEl.innerHTML = "";

  if (projects.length === 0) {
    projectsListEl.innerHTML = `<p class="log-line">No projects yet.</p>`;
    return;
  }

  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "project-item" + (p.id === currentProjectId ? " active" : "");
    item.dataset.projectId = p.id;
    item.innerHTML = `
      <button class="proj-delete" title="Delete project">×</button>
      <div class="proj-name">${escapeHtml(p.name)}</div>
      <div class="proj-meta">${new Date(p.created_at).toLocaleDateString()}</div>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("proj-delete")) return;
      openProject(p);
    });
    item.querySelector(".proj-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
      await fetch(`/projects/${p.id}`, { method: "DELETE" });
      if (currentProjectId === p.id) goHome();
      loadProjectsList();
    });
    projectsListEl.appendChild(item);
  }
}

function highlightActiveProject(id) {
  document.querySelectorAll(".project-item").forEach(el => {
    el.classList.toggle("active", el.dataset.projectId === id);
  });
}

function goHome() {
  currentProjectId = null;
  currentRunId = null;
  statusBox.style.display = "none";
  clearInterval(pollTimer);
  mainPanel.innerHTML = `<h2>Welcome</h2><p class="log-line">Pick a project on the left, or click "+ New project" to upload one.</p>`;
  document.querySelectorAll(".project-item").forEach(el => el.classList.remove("active"));
}

homeLink.addEventListener("click", goHome);
newProjectBtn.addEventListener("click", renderNewProjectView);

let projectsCollapsed = false;
projectsToggle.addEventListener("click", () => {
  projectsCollapsed = !projectsCollapsed;
  projectsListEl.style.display = projectsCollapsed ? "none" : "block";
  projectsChevron.textContent = projectsCollapsed ? "▼" : "▲";
});

async function openProject(project) {
  currentProjectId = project.id;
  currentRunId = null;
  highlightActiveProject(project.id);
  clearInterval(pollTimer);
  statusBox.style.display = "none";

  mainPanel.innerHTML = `<p class="log-line"><span class="spinner"></span>Loading…</p>`;
  const res = await fetch(`/projects/${project.id}/runs`);
  const runs = await res.json();

  mainPanel.innerHTML = "";
  const header = document.createElement("div");
  header.innerHTML = `<h2>${escapeHtml(project.name)}</h2><p class="log-line">Created ${new Date(project.created_at).toLocaleString()}</p>`;
  mainPanel.appendChild(header);

  const newRunBtn = document.createElement("button");
  newRunBtn.className = "primary";
  newRunBtn.style.width = "auto";
  newRunBtn.style.marginTop = "8px";
  newRunBtn.textContent = "+ Start new run";
  newRunBtn.onclick = () => startNewRun(project);
  mainPanel.appendChild(newRunBtn);

  const runsHeader = document.createElement("h4");
  runsHeader.textContent = "Run history";
  runsHeader.style.marginTop = "24px";
  mainPanel.appendChild(runsHeader);

  if (runs.length === 0) {
    const p = document.createElement("p");
    p.className = "log-line";
    p.textContent = "No runs yet — click \"Start new run\" above.";
    mainPanel.appendChild(p);
  }

  for (const r of runs) {
    const item = document.createElement("div");
    item.className = "run-item";
    item.innerHTML = `<span>Run ${r.id.slice(0, 8)} — ${new Date(r.created_at).toLocaleString()}</span><span class="badge ${r.status}">${escapeHtml(r.status)}</span>`;
    item.onclick = () => openRun(r.id);
    mainPanel.appendChild(item);
  }
}

async function startNewRun(project) {
  mainPanel.innerHTML = `<h2>Starting run…</h2><p class="log-line"><span class="spinner"></span>Setting things up.</p>`;
  const res = await fetch(`/projects/${project.id}/runs`, { method: "POST" });
  const run = await res.json();
  if (!res.ok) {
    mainPanel.innerHTML = `<h2 style="color:#791f1f">Error</h2><p class="log-line">${escapeHtml(run.error || "Could not start run")}</p>`;
    return;
  }
  currentRunId = run.runId;
  statusBox.style.display = "block";
  runIdEl.textContent = `Run ${run.runId.slice(0, 8)}`;
  mainPanel.innerHTML = `<h2>Running pipeline…</h2><p class="log-line"><span class="spinner"></span>Scanning files, this usually takes a few seconds.</p>`;
  pollRun(run.runId);
}

async function openRun(runId) {
  currentRunId = runId;
  statusBox.style.display = "block";
  runIdEl.textContent = `Run ${runId.slice(0, 8)}`;

  const res = await fetch(`/runs/${runId}`);
  const run = await res.json();
  if (!res.ok) {
    mainPanel.innerHTML = `<h2 style="color:#791f1f">Error</h2><p class="log-line">${escapeHtml(run.error || "Run not found")}</p>`;
    return;
  }

  runStatusEl.textContent = run.status;
  runStatusEl.className = `badge ${run.status}`;

  if (run.status === "running" || run.status === "pending") {
    mainPanel.innerHTML = `<h2>Running pipeline…</h2><p class="log-line"><span class="spinner"></span>Scanning files, this usually takes a few seconds.</p>`;
    pollRun(runId);
  } else {
    renderRun(run);
  }
}

// Zips a FileList from <input webkitdirectory>, stripping the top-level
// folder name so the zip root matches what a manually-zipped folder would
// look like (locale folders directly at the root, not nested one level deep).
async function zipFileListToBlob(fileList) {
  const zip = new JSZip();
  for (const file of fileList) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/");
    const strippedPath = parts.length > 1 ? parts.slice(1).join("/") : relPath;
    zip.file(strippedPath, file);
  }
  return zip.generateAsync({ type: "blob" });
}

// Zips dropped DataTransferItem entries (drag-and-drop folder case),
// recursively walking the directory tree via the FileSystem API.
async function zipEntriesToBlob(entries) {
  const zip = new JSZip();

  function readEntry(entry, basePath) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          zip.file(basePath + entry.name, file);
          resolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reader.readEntries(async (children) => {
          await Promise.all(children.map(child => readEntry(child, basePath + entry.name + "/")));
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // If there's exactly one top-level directory, skip straight to its
  // children so the zip root matches (locale folders at the top, not
  // nested one level inside the dropped folder's own name).
  const singleTopDir = entries.length === 1 && entries[0].isDirectory;
  if (singleTopDir) {
    const reader = entries[0].createReader();
    const children = await new Promise((resolve) => reader.readEntries(resolve));
    await Promise.all(children.map(child => readEntry(child, "")));
  } else {
    await Promise.all(entries.map(entry => readEntry(entry, "")));
  }

  return zip.generateAsync({ type: "blob" });
}

// Builds the "New project" form fresh inside mainPanel each time it's
// opened — upload happens as part of naming the project, not as a
// separate always-visible sidebar box.
function renderNewProjectView() {
  currentProjectId = null;
  currentRunId = null;
  statusBox.style.display = "none";
  clearInterval(pollTimer);
  document.querySelectorAll(".project-item").forEach(el => el.classList.remove("active"));

  mainPanel.innerHTML = `
    <h2>New project</h2>
    <p class="log-line">Upload a zip of your source files, or drop/choose a folder — it'll be zipped automatically.</p>
    <div class="upload-box" id="dropZone">
      <input type="file" id="fileInput" accept=".zip" hidden>
      <input type="file" id="folderInput" webkitdirectory directory multiple hidden>
      <p id="dropLabel">📁 Drop a .zip or a folder here</p>
      <p class="log-line">or <a href="#" id="chooseFolderLink">choose a folder</a> instead</p>
      <p class="log-line" id="fileName"></p>
    </div>
    <input type="text" id="projectName" placeholder="Project name" class="text-input" style="margin-top:12px;max-width:320px">
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="primary" id="uploadBtn" style="width:auto" disabled>Upload &amp; Start Run</button>
      <button id="cancelUploadBtn">Cancel</button>
    </div>
  `;

  const dropZone = mainPanel.querySelector("#dropZone");
  const fileInput = mainPanel.querySelector("#fileInput");
  const folderInput = mainPanel.querySelector("#folderInput");
  const chooseFolderLink = mainPanel.querySelector("#chooseFolderLink");
  const fileNameEl = mainPanel.querySelector("#fileName");
  const uploadBtn = mainPanel.querySelector("#uploadBtn");
  const projectNameInput = mainPanel.querySelector("#projectName");
  const cancelBtn = mainPanel.querySelector("#cancelUploadBtn");

  selectedFile = null;

  function setFile(file) {
    selectedFile = file;
    fileNameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    uploadBtn.disabled = false;
  }

  dropZone.addEventListener("click", (e) => {
    if (e.target === chooseFolderLink) return;
    fileInput.click();
  });
  chooseFolderLink.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    folderInput.click();
  });
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));

  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");

    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = Array.from(items).map(i => i.webkitGetAsEntry()).filter(Boolean);
      if (entries.some(en => en.isDirectory)) {
        fileNameEl.textContent = "Reading folder…";
        const zipBlob = await zipEntriesToBlob(entries);
        setFile(new File([zipBlob], "folder-upload.zip", { type: "application/zip" }));
        return;
      }
    }
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) setFile(fileInput.files[0]);
  });

  folderInput.addEventListener("change", async () => {
    if (!folderInput.files.length) return;
    fileNameEl.textContent = "Zipping folder…";
    const zipBlob = await zipFileListToBlob(folderInput.files);
    setFile(new File([zipBlob], "folder-upload.zip", { type: "application/zip" }));
  });

  uploadBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading…";
    mainPanel.innerHTML = `<h2>Uploading…</h2><p class="log-line">Extracting and indexing your project.</p>`;

    try {
      const form = new FormData();
      form.append("file", selectedFile);
      form.append("name", projectNameInput.value.trim() || selectedFile.name.replace(/\.zip$/i, ""));

      const projectRes = await fetch("/projects", { method: "POST", body: form });
      const project = await projectRes.json();
      if (!projectRes.ok) throw new Error(project.error || "Upload failed");
      currentProjectId = project.id;

      const runRes = await fetch(`/projects/${project.id}/runs`, { method: "POST" });
      const run = await runRes.json();
      if (!runRes.ok) throw new Error(run.error || "Could not start run");
      currentRunId = run.runId;

      await loadProjectsList();
      highlightActiveProject(project.id);

      statusBox.style.display = "block";
      runIdEl.textContent = `Run ${run.runId.slice(0, 8)}`;
      mainPanel.innerHTML = `<h2>Running pipeline…</h2><p class="log-line"><span class="spinner"></span>Scanning files, this usually takes a few seconds.</p>`;

      pollRun(run.runId);
    } catch (err) {
      mainPanel.innerHTML = `<h2 style="color:#791f1f">Error</h2><p class="log-line">${escapeHtml(err.message)}</p>`;
    }
  });

  cancelBtn.addEventListener("click", goHome);
}

function pollRun(runId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const res = await fetch(`/runs/${runId}`);
    const run = await res.json();
    if (!res.ok) return;

    runStatusEl.textContent = run.status;
    runStatusEl.className = `badge ${run.status}`;

    if (run.status === "done" || run.status === "failed") {
      clearInterval(pollTimer);
      renderRun(run);
    }
  }, 1000);
}

// Initial load
loadProjectsList();

function renderRun(run) {
  mainPanel.innerHTML = `<a href="#" id="backToProjectLink" class="log-line" style="color:#185fa5">← Back to project</a><h2>Run ${run.id.slice(0, 8)} — ${run.status}</h2>`;
  document.getElementById("backToProjectLink").onclick = async (e) => {
    e.preventDefault();
    const res = await fetch(`/projects/${currentProjectId}`);
    const project = await res.json();
    if (res.ok) openProject(project);
  };
  for (const step of run.steps) {
    const card = document.createElement("div");
    card.className = "step-card";
    let result = null;
    try { result = step.result_json ? JSON.parse(step.result_json) : null; } catch {}

    // Clickable header — title, badge, description, one-line summary
    const header = document.createElement("div");
    header.style.cssText = "cursor:pointer";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;align-items:center;gap:10px";
    const title = document.createElement("strong");
    title.textContent = stepTitle(step.step_key);
    const badge = document.createElement("span");
    badge.className = `badge ${step.status}`;
    badge.textContent = step.status;
    const chevron = document.createElement("span");
    chevron.style.cssText = "margin-left:auto;font-size:12px;color:#9a988f";
    chevron.textContent = "▼";
    titleRow.appendChild(title);
    titleRow.appendChild(badge);
    titleRow.appendChild(chevron);
    header.appendChild(titleRow);

    const desc = document.createElement("p");
    desc.className = "log-line";
    desc.style.margin = "6px 0 0";
    desc.textContent = stepDescription(step.step_key);
    header.appendChild(desc);

    const summary = document.createElement("p");
    summary.className = "summary-line";
    summary.style.margin = "4px 0 0";
    summary.textContent = stepSummary(step.step_key, step.status, result);
    header.appendChild(summary);

    card.appendChild(header);

    // Collapsible body — full detail, hidden by default
    const body = document.createElement("div");
    body.style.cssText = "margin-top:12px;display:none";

    if (step.status === "failed") {
      body.innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(result?.error || "Step failed")}</p>`;
    } else if (step.step_key === "inventory" && result) {
      renderInventory(body, result);
    } else if (step.step_key === "encoding_qa" && result) {
      renderEncodingQA(body, result);
    } else if (step.step_key === "placeholder_analysis" && result) {
      renderPlaceholderAnalysis(body, result);
    } else {
      body.innerHTML = `<p class="log-line">No details yet.</p>`;
    }
    card.appendChild(body);

    let open = false;
    header.onclick = () => {
      open = !open;
      body.style.display = open ? "block" : "none";
      chevron.textContent = open ? "▲" : "▼";
    };

    mainPanel.appendChild(card);
  }

  mainPanel.appendChild(buildCatImportCard());
  mainPanel.appendChild(buildRenamerCard());
  mainPanel.appendChild(buildOutputQaCard());
  mainPanel.appendChild(buildRainbowFixCard());
}

function stepDescription(key) {
  return {
    inventory: "Scans the project folder and classifies every file — translatable resources, content files, known assets, and unrecognized files.",
    encoding_qa: "Detects encoding, EOL style, and BOM for all source files.",
    placeholder_analysis: "Scans source files for placeholder syntax (%s, {name}, {{var}}, HTML tags, URLs, etc.) and generates ready-to-paste Trados regex rules."
  }[key] || "";
}

function stepSummary(key, status, result) {
  if (status === "failed") return "Click for the error";
  if (!result) return status === "running" ? "Running…" : "Click for details";
  if (key === "inventory") return `${result.total_files ?? "?"} files found — click for the full breakdown`;
  if (key === "encoding_qa") return `${result.file_count ?? "?"} file(s) scanned` + (result.skipped_binary ? `, ${result.skipped_binary} binary skipped` : "") + " — click to see encoding/EOL breakdown";
  if (key === "placeholder_analysis") return `${result.files_scanned ?? "?"} file(s) scanned, ${result.total_patterns ?? 0} pattern(s) found — click for details`;
  return "Click for details";
}

function stepTitle(key) {
  return {
    inventory: "🔍 File inventory",
    encoding_qa: "🔤 Encoding & line-ending QA",
    placeholder_analysis: "🏷️ Placeholder pattern analysis"
  }[key] || key;
}

function renderInventory(container, result) {
  const summary = document.createElement("p");
  summary.className = "summary-line";
  summary.textContent = `${result.total_files} file(s) found`;
  container.appendChild(summary);

  // Extension breakdown table
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;margin:10px 0;font-size:12px";
  const exts = Object.entries(result.by_extension).sort((a, b) => b[1] - a[1]);
  table.innerHTML = `<tr style="text-align:left;color:#5f5e5a"><th style="padding:4px 8px">Extension</th><th style="padding:4px 8px">Count</th></tr>` +
    exts.map(([ext, count]) => `<tr><td style="padding:4px 8px;border-top:1px solid #eceae2">${escapeHtml(ext)}</td><td style="padding:4px 8px;border-top:1px solid #eceae2">${count}</td></tr>`).join("");
  container.appendChild(table);

  const groups = [
    { label: "Resource files — translatable", files: result.loc_files, open: true },
    { label: "Content files — HTML/Markdown/text", files: result.content_files },
    { label: "Known assets — not translatable", files: result.asset_files },
    { label: "Unrecognized files", files: result.unrecognized_files }
  ];

  for (const g of groups) {
    if (!g.files || g.files.length === 0) continue;
    container.appendChild(buildCollapsibleFileGroup(`${g.label} (${g.files.length})`, g.files, g.open));
  }
}

function buildCollapsibleFileGroup(label, files, startOpen) {
  const wrap = document.createElement("div");
  wrap.className = "ext-group";

  const header = document.createElement("button");
  header.className = "ext-group-header";
  header.style.cssText = "width:100%;border:none;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px";
  const toggleIcon = document.createElement("span");
  toggleIcon.style.marginLeft = "auto";
  toggleIcon.style.fontSize = "11px";
  header.appendChild(document.createTextNode(label));
  header.appendChild(toggleIcon);

  const body = document.createElement("div");
  body.className = "file-list";
  body.style.marginTop = "6px";
  for (const f of files) {
    const line = document.createElement("div");
    line.textContent = f;
    body.appendChild(line);
  }

  let open = !!startOpen;
  function sync() { body.style.display = open ? "block" : "none"; toggleIcon.textContent = open ? "▲" : "▼"; }
  sync();
  header.onclick = () => { open = !open; sync(); };

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function renderEncodingQA(container, result) {
  const summary = document.createElement("p");
  summary.className = "summary-line";
  summary.textContent = `${result.file_count} file(s) scanned` + (result.skipped_binary ? `, ${result.skipped_binary} binary skipped` : "");
  container.appendChild(summary);

  const encodingTally = {}, eolTally = {};
  for (const f of result.files) {
    encodingTally[f.encoding] = (encodingTally[f.encoding] || 0) + 1;
    eolTally[f.eol] = (eolTally[f.eol] || 0) + 1;
  }

  container.appendChild(buildBarGroup("Encoding", encodingTally));
  container.appendChild(buildBarGroup("Line endings", eolTally));
}

function buildBarGroup(label, tally) {
  const wrap = document.createElement("div");
  wrap.className = "bar-group";
  const title = document.createElement("div");
  title.className = "bar-group-title";
  title.textContent = label;
  wrap.appendChild(title);

  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  entries.forEach(([name, count], i) => {
    const pct = Math.max(2, Math.round((count / total) * 100));
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">${escapeHtml(name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color(i)}"></div></div>
      <div class="bar-count">${count} (${pct}%)</div>
    `;
    wrap.appendChild(row);
  });
  return wrap;
}

function renderPlaceholderAnalysis(container, result) {
  const summary = document.createElement("p");
  summary.className = "summary-line";
  summary.textContent = `${result.files_scanned} file(s) scanned — ${result.total_patterns} pattern(s) found`;
  container.appendChild(summary);

  const exts = Object.keys(result.by_extension).sort();
  if (exts.length === 0) {
    const p = document.createElement("p");
    p.className = "log-line";
    p.textContent = "No placeholder patterns found.";
    container.appendChild(p);
    return;
  }

  for (const ext of exts) {
    container.appendChild(buildExtGroup(ext, result.by_extension[ext]));
  }
}

function buildExtGroup(ext, patternsObj) {
  const patterns = Object.values(patternsObj).sort((a, b) => b.count - a.count);
  const wrap = document.createElement("div");
  wrap.className = "ext-group";

  const header = document.createElement("button");
  header.className = "ext-group-header";
  header.style.cssText = "width:100%;border:none;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px";
  const toggleIcon = document.createElement("span");
  toggleIcon.style.marginLeft = "auto";
  toggleIcon.style.fontSize = "11px";
  toggleIcon.textContent = "▲";
  header.innerHTML = `<span style="font-family:ui-monospace,monospace">${escapeHtml(ext)}</span><span style="font-size:12px;font-weight:400;color:#5f5e5a">${patterns.length} pattern${patterns.length !== 1 ? "s" : ""}</span>`;
  header.appendChild(toggleIcon);

  const body = document.createElement("div");
  body.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:10px";
  let open = true;
  header.onclick = () => {
    open = !open;
    body.style.display = open ? "flex" : "none";
    toggleIcon.textContent = open ? "▲" : "▼";
  };

  for (const pat of patterns) body.appendChild(buildPatternCard(pat));

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function buildPatternCard(pat) {
  const card = document.createElement("div");
  card.className = "pattern-card";

  // Header row: label + count + files toggle
  const header = document.createElement("div");
  header.className = "pattern-header";
  const labelWrap = document.createElement("div");
  labelWrap.style.cssText = "flex:1;min-width:180px";
  labelWrap.innerHTML = `<span class="pattern-label">${escapeHtml(pat.label)}</span><span class="pattern-count" style="margin-left:8px">${pat.count} occurrence${pat.count !== 1 ? "s" : ""} in ${pat.files.length} file${pat.files.length !== 1 ? "s" : ""}</span>`;
  header.appendChild(labelWrap);

  const filesBtn = document.createElement("button");
  filesBtn.className = "copy-btn";
  filesBtn.style.cssText = "background:#fff;color:#5f5e5a;border:1px solid #ccc";
  filesBtn.textContent = "▼ files";
  let filesOpen = false;
  header.appendChild(filesBtn);
  card.appendChild(header);

  const desc = document.createElement("p");
  desc.className = "pattern-desc";
  desc.textContent = pat.description;
  card.appendChild(desc);

  // Examples: preview 3, toggle to show all
  const PREVIEW_COUNT = 3;
  const examplesWrap = document.createElement("div");
  examplesWrap.style.marginBottom = "4px";
  const showAllBtn = document.createElement("button");
  showAllBtn.className = "copy-btn";
  showAllBtn.style.cssText = "background:transparent;color:#5f5e5a;border:1px solid #ccc;margin-bottom:6px";
  let examplesOpen = false;

  function renderExamples() {
    examplesWrap.innerHTML = "";
    const visible = examplesOpen ? pat.examples : pat.examples.slice(0, PREVIEW_COUNT);
    for (const ex of visible) {
      const chip = document.createElement("code");
      chip.className = "example-chip";
      chip.textContent = ex;
      examplesWrap.appendChild(chip);
    }
  }
  renderExamples();
  card.appendChild(examplesWrap);

  if (pat.examples.length > PREVIEW_COUNT) {
    showAllBtn.textContent = `▼ show all ${pat.examples.length} examples`;
    showAllBtn.onclick = () => {
      examplesOpen = !examplesOpen;
      showAllBtn.textContent = examplesOpen ? "▲ show less" : `▼ show all ${pat.examples.length} examples`;
      renderExamples();
    };
    card.appendChild(showAllBtn);
  }

  // Trados regex row
  const tradosRow = document.createElement("div");
  tradosRow.className = "trados-row";
  const code = document.createElement("code");
  code.className = "trados-code";
  code.textContent = pat.trados;
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(pat.trados);
    copyBtn.textContent = "✓ copied";
    copyBtn.classList.add("copied");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1500);
  };
  tradosRow.appendChild(code);
  tradosRow.appendChild(copyBtn);
  card.appendChild(tradosRow);

  // File list (collapsed by default)
  const fileList = document.createElement("div");
  fileList.className = "file-list";
  fileList.style.display = "none";
  for (const f of pat.files) {
    const line = document.createElement("div");
    line.textContent = f;
    fileList.appendChild(line);
  }
  filesBtn.onclick = () => {
    filesOpen = !filesOpen;
    fileList.style.display = filesOpen ? "block" : "none";
    filesBtn.textContent = filesOpen ? "▲ hide files" : "▼ files";
  };
  card.appendChild(fileList);

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── CAT tool handoff card ────────────────────────────────────────────────
function buildCatImportCard() {
  const card = document.createElement("div");
  card.className = "step-card";
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <strong>🌐 Import into CAT tool</strong>
      <span class="badge" id="catBadge">manual</span>
    </div>
    <p class="log-line" style="margin:6px 0 0">You should manually set up a Trados project with these locales, import the source files, and do translation/pseudo-loc there. Click <strong>Mark as done</strong> once export is complete.</p>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Source locale</label>
        <input type="text" id="catSourceLocale" class="text-input" style="width:120px;margin:0" value="en">
      </div>
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Target locales (comma-separated)</label>
        <input type="text" id="catTargetLocales" class="text-input" style="width:220px;margin:0" placeholder="tr, de-DE, fr-FR">
      </div>
      <button class="primary" id="catDoneBtn" style="width:auto;margin:0">Mark as done</button>
      <button id="catSkipBtn" style="width:auto;margin:0">Skip</button>
    </div>
    <div id="catResult" style="margin-top:12px"></div>
  `;

  card.querySelector("#catDoneBtn").onclick = async () => {
    const sourceLocale = card.querySelector("#catSourceLocale").value.trim() || "en";
    const locales = card.querySelector("#catTargetLocales").value.split(",").map(s => s.trim()).filter(Boolean);
    const resBox = card.querySelector("#catResult");

    const res = await fetch(`/runs/${currentRunId}/steps/cat-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceLocale, locales })
    });
    const data = await res.json();
    if (!res.ok) { resBox.innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(data.error || "Failed")}</p>`; return; }

    card.querySelector("#catBadge").textContent = "done";
    card.querySelector("#catBadge").className = "badge done";
    resBox.innerHTML = `<p style="color:#27500a;font-weight:600;margin:0">✓ Marked done — ${locales.length ? escapeHtml(locales.join(", ")) : "no target locales specified"}</p>`;
  };

  card.querySelector("#catSkipBtn").onclick = async () => {
    await fetch(`/runs/${currentRunId}/steps/cat_import/skip`, { method: "POST" });
    card.querySelector("#catBadge").textContent = "skipped";
    card.querySelector("#catBadge").className = "badge";
    card.querySelector("#catResult").innerHTML = `<p class="log-line">Step skipped.</p>`;
  };

  return card;
}

// ── Renamer card ─────────────────────────────────────────────────────────
function buildRenamerCard() {
  const card = document.createElement("div");
  card.className = "step-card";
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <strong>📝 Normalize filenames</strong>
      <span class="badge" id="renBadge">confirm</span>
    </div>
    <p class="log-line" style="margin:6px 0 0">Renames files inside locale subfolders to a chosen naming convention. Preview first — nothing is changed until you click Apply.</p>
    <div style="margin-top:12px">
      <button id="renChooseFolderBtn" style="display:flex;align-items:center;gap:6px">📁 Choose root folder</button>
      <span class="log-line" id="renRootStatus" style="margin-left:8px"></span>
      <p class="log-line" style="margin-top:4px">Upload the folder you got back from Trados — the one with your target-locale subfolders (tr/, de-DE/, etc.). This is separate from the source project you uploaded at the start.</p>
      <input type="file" id="renFolderInput" webkitdirectory directory multiple hidden>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Source locale</label>
        <input type="text" id="renSourceLocale" class="text-input" style="width:100px;margin:0" value="en">
      </div>
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Target locales (comma-separated)</label>
        <input type="text" id="renLocales" class="text-input" style="width:180px;margin:0" placeholder="tr, de-DE">
      </div>
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Naming format</label>
        <select id="renFormat" class="text-input" style="margin:0;width:280px"></select>
      </div>
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Exclude locale (comma-separated)</label>
        <input type="text" id="renExclude" class="text-input" style="width:100px;margin:0" value="en">
      </div>
      <label style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:8px">
        <input type="checkbox" id="renSkipAssets" checked> Skip assets
      </label>
      <button id="renPreviewBtn" style="margin:0" disabled>Preview changes</button>
      <button id="renSkipBtn" style="margin:0">Skip</button>
    </div>
    <div id="renResult" style="margin-top:12px"></div>
  `;

  let renRootPath = null;

  const chooseFolderBtn = card.querySelector("#renChooseFolderBtn");
  const renFolderInput = card.querySelector("#renFolderInput");
  const renRootStatus = card.querySelector("#renRootStatus");
  const previewBtn = card.querySelector("#renPreviewBtn");

  chooseFolderBtn.onclick = () => renFolderInput.click();
  renFolderInput.addEventListener("change", async () => {
    if (!renFolderInput.files.length) return;
    renRootStatus.textContent = "Zipping and uploading…";
    try {
      const zipBlob = await zipFileListToBlob(renFolderInput.files);
      const form = new FormData();
      form.append("file", zipBlob, "root-upload.zip");
      const res = await fetch(`/runs/${currentRunId}/steps/renamer/upload-root`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      renRootPath = data.path;
      renRootStatus.textContent = `✓ ${renFolderInput.files.length} file(s) uploaded`;
      previewBtn.disabled = false;
    } catch (err) {
      renRootStatus.textContent = "";
      card.querySelector("#renResult").innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(err.message)}</p>`;
    }
  });

  // Populate format dropdown
  fetch("/locale-formats").then(r => r.json()).then(formats => {
    const select = card.querySelector("#renFormat");
    select.innerHTML = formats.map(f => `<option value="${f.id}" ${f.recommended ? "selected" : ""}>${escapeHtml(f.label)} — ${escapeHtml(f.example)}${f.recommended ? " ★" : ""}</option>`).join("");
  });

  function getParams() {
    return {
      rootPath: renRootPath,
      sourceLocale: card.querySelector("#renSourceLocale").value.trim() || null,
      locales: card.querySelector("#renLocales").value.split(",").map(s => s.trim()).filter(Boolean),
      formatId: Number(card.querySelector("#renFormat").value),
      skipAssets: card.querySelector("#renSkipAssets").checked,
      excludeLocales: card.querySelector("#renExclude").value.split(",").map(s => s.trim()).filter(Boolean)
    };
  }

  function renderPlan(result) {
    const resBox = card.querySelector("#renResult");
    resBox.innerHTML = "";

    if (result.skipped) {
      resBox.innerHTML = `<p class="log-line" style="color:#854f0b">${escapeHtml((result.reason || "skipped").replace(/_/g, " "))}</p>`;
      return;
    }

    const summary = document.createElement("p");
    summary.className = "summary-line";
    summary.textContent = `${result.total_planned} file(s) will be renamed across ${Object.keys(result.by_locale).length} locale(s).` +
      (result.skipped_assets.length ? ` ${result.skipped_assets.length} asset(s) skipped.` : "");
    resBox.appendChild(summary);

    for (const [locale, entries] of Object.entries(result.by_locale)) {
      if (entries.length === 0) continue;
      const group = buildCollapsibleFileGroup(`${locale} (${entries.length} file${entries.length !== 1 ? "s" : ""})`, entries.map(e => `${e.from}  →  ${e.to}`), false);
      resBox.appendChild(group);
    }

    if (!result.dry_run) {
      const ok = document.createElement("p");
      ok.style.cssText = "color:#27500a;font-weight:600;margin-top:10px";
      ok.textContent = `✓ ${result.renamed} file(s) renamed.` + (result.errors.length ? ` ${result.errors.length} error(s).` : "");
      resBox.appendChild(ok);

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "primary";
      downloadBtn.style.cssText = "width:auto;margin-top:8px";
      downloadBtn.textContent = "↓ Download renamed project (.zip)";
      downloadBtn.onclick = () => { window.location.href = `/runs/${currentRunId}/steps/renamer/download`; };
      resBox.appendChild(downloadBtn);
    } else {
      const applyBtn = document.createElement("button");
      applyBtn.className = "primary";
      applyBtn.style.cssText = "width:auto;margin-top:10px";
      applyBtn.textContent = "Apply — rename files";
      applyBtn.onclick = () => runRenamer("/apply", applyBtn);
      resBox.appendChild(applyBtn);
    }
  }

  async function runRenamer(endpoint, triggerBtn) {
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Working…"; }
    const resBox = card.querySelector("#renResult");
    if (!triggerBtn) resBox.innerHTML = `<p class="log-line"><span class="spinner"></span>Scanning…</p>`;

    const res = await fetch(`/runs/${currentRunId}/steps/renamer${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getParams())
    });
    const data = await res.json();
    if (!res.ok) { resBox.innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(data.error || "Failed")}</p>`; return; }

    card.querySelector("#renBadge").textContent = data.result.skipped ? "failed" : "done";
    card.querySelector("#renBadge").className = `badge ${data.result.skipped ? "failed" : "done"}`;
    renderPlan(data.result);
  }

  card.querySelector("#renPreviewBtn").onclick = () => runRenamer("/preview");
  card.querySelector("#renSkipBtn").onclick = async () => {
    await fetch(`/runs/${currentRunId}/steps/renamer/skip`, { method: "POST" });
    card.querySelector("#renBadge").textContent = "skipped";
    card.querySelector("#renBadge").className = "badge";
    card.querySelector("#renResult").innerHTML = `<p class="log-line">Step skipped.</p>`;
  };

  return card;
}

// ── Output encoding & line-ending QA card ───────────────────────────────
function buildOutputQaCard() {
  const card = document.createElement("div");
  card.className = "step-card";
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <strong>✅ Output encoding & line-ending QA</strong>
      <span class="badge" id="qaBadge">confirm</span>
    </div>
    <p class="log-line" style="margin:6px 0 0">Checks your renamed/output files against the source baseline — flags encoding mismatches, line-ending inconsistencies, and invisible characters.</p>

    <div style="margin-top:12px">
      <button id="qaChooseOutputBtn">📁 Choose output folder to check</button>
      <span class="log-line" id="qaOutputStatus" style="margin-left:8px">Defaults to whatever the renamer step just produced, if any.</span>
      <input type="file" id="qaOutputFolderInput" webkitdirectory directory multiple hidden>
    </div>

    <div style="margin-top:10px">
      <button id="qaChooseSourceBtn">📁 Choose source folder (optional)</button>
      <span class="log-line" id="qaSourceStatus" style="margin-left:8px">Defaults to your originally uploaded project.</span>
      <input type="file" id="qaSourceFolderInput" webkitdirectory directory multiple hidden>
    </div>

    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="primary" id="qaRunBtn" style="width:auto">Run QA check</button>
      <button id="qaSkipBtn">Skip</button>
    </div>
    <div id="qaResult" style="margin-top:12px"></div>
  `;

  const outputBtn = card.querySelector("#qaChooseOutputBtn");
  const outputInput = card.querySelector("#qaOutputFolderInput");
  const outputStatus = card.querySelector("#qaOutputStatus");
  const sourceBtn = card.querySelector("#qaChooseSourceBtn");
  const sourceInput = card.querySelector("#qaSourceFolderInput");
  const sourceStatus = card.querySelector("#qaSourceStatus");

  outputBtn.onclick = () => outputInput.click();
  sourceBtn.onclick = () => sourceInput.click();

  async function uploadFolder(fileList, endpoint, statusEl, label) {
    statusEl.textContent = "Zipping and uploading…";
    try {
      const zipBlob = await zipFileListToBlob(fileList);
      const form = new FormData();
      form.append("file", zipBlob, `${label}.zip`);
      const res = await fetch(`/runs/${currentRunId}/steps/output-qa/${endpoint}`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      statusEl.textContent = `✓ ${fileList.length} file(s) uploaded`;
    } catch (err) {
      statusEl.textContent = "";
      card.querySelector("#qaResult").innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(err.message)}</p>`;
    }
  }

  outputInput.addEventListener("change", () => {
    if (outputInput.files.length) uploadFolder(outputInput.files, "upload-output", outputStatus, "output-upload");
  });
  sourceInput.addEventListener("change", () => {
    if (sourceInput.files.length) uploadFolder(sourceInput.files, "upload-source", sourceStatus, "source-upload");
  });

  card.querySelector("#qaRunBtn").onclick = async () => {
    const resBox = card.querySelector("#qaResult");
    resBox.innerHTML = `<p class="log-line"><span class="spinner"></span>Scanning…</p>`;

    const res = await fetch(`/runs/${currentRunId}/steps/output-qa/run`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { resBox.innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(data.error || "Failed")}</p>`; return; }

    const result = data.result;
    card.querySelector("#qaBadge").textContent = result.skipped ? "failed" : "done";
    card.querySelector("#qaBadge").className = `badge ${result.skipped ? "failed" : "done"}`;
    renderOutputQaResult(resBox, result);

    // Auto-detect Rainbow fix groups the moment errors are found — matches
    // the desktop app's automatic behavior. Only the actual Rainbow launch
    // can't happen automatically here, since there's no local app to spawn
    // from a server.
    if (!result.skipped && result.errors > 0 && typeof triggerRainbowGenerate === "function") {
      await triggerRainbowGenerate();
    }
  };

  card.querySelector("#qaSkipBtn").onclick = async () => {
    await fetch(`/runs/${currentRunId}/steps/output_encoding_qa/skip`, { method: "POST" });
    card.querySelector("#qaBadge").textContent = "skipped";
    card.querySelector("#qaBadge").className = "badge";
    card.querySelector("#qaResult").innerHTML = `<p class="log-line">Step skipped.</p>`;
  };

  return card;
}

function renderOutputQaResult(container, result) {
  container.innerHTML = "";

  if (result.skipped) {
    container.innerHTML = `<p class="log-line" style="color:#854f0b">${escapeHtml((result.reason || "skipped").replace(/_/g, " "))}</p>`;
    return;
  }

  const summary = document.createElement("p");
  summary.className = "summary-line";
  summary.textContent = `${result.files_scanned} file(s) scanned — ${result.clean_count} clean, ${result.errors} error(s), ${result.warnings} warning(s)` +
    (result.skipped_binary ? `, ${result.skipped_binary} binary skipped` : "") +
    (result.no_source_match ? `, ${result.no_source_match} with no matching source file` : "");
  container.appendChild(summary);

  const passLine = document.createElement("p");
  passLine.style.cssText = `font-weight:600;margin:8px 0;color:${result.passed ? "#27500a" : "#791f1f"}`;
  passLine.textContent = result.passed ? "✓ All files pass" : `✗ ${result.errors} error(s), ${result.warnings} warning(s)`;
  container.appendChild(passLine);

  const errorFiles = (result.issues || []).filter(f => f.issues.some(i => i.severity === "error"));
  const warningFiles = (result.issues || []).filter(f => f.issues.every(i => i.severity === "warning"));

  if (errorFiles.length > 0) {
    container.appendChild(buildCollapsibleIssueSection(`Files with errors (${errorFiles.length})`, errorFiles, "#791f1f"));
  }
  if (warningFiles.length > 0) {
    container.appendChild(buildCollapsibleIssueSection(`Files with warnings only (${warningFiles.length})`, warningFiles, "#854f0b"));
  }

  if (errorFiles.length === 0 && warningFiles.length === 0) {
    const p = document.createElement("p");
    p.className = "log-line";
    p.textContent = "No issues found in any output file.";
    container.appendChild(p);
  }
}

function buildQaFileRow(f) {
  const row = document.createElement("div");
  row.style.cssText = "border:1px solid #d3d1c7;border-radius:6px;padding:8px 12px;margin-bottom:8px;background:#fafaf8";

  const title = document.createElement("div");
  title.style.cssText = "font-family:ui-monospace,monospace;font-size:12px;font-weight:600";
  title.textContent = f.file;
  row.appendChild(title);

  if (f.comparedTo) {
    const cmp = document.createElement("div");
    cmp.className = "log-line";
    cmp.textContent = `vs ${f.comparedTo}`;
    row.appendChild(cmp);
  }

  const list = document.createElement("ul");
  list.style.cssText = "margin:6px 0 0;padding-left:18px;font-size:12px";
  for (const issue of f.issues) {
    const li = document.createElement("li");
    li.style.color = issue.severity === "error" ? "#791f1f" : "#854f0b";
    li.textContent = `[${issue.severity}] ${issue.check.replace(/_/g, " ")}: ${issue.detail}`;
    list.appendChild(li);
  }
  row.appendChild(list);

  return row;
}

// Collapsed by default — just a summary count. Click to reveal full file list.
function buildCollapsibleIssueSection(label, files, color) {
  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px";

  const btn = document.createElement("button");
  btn.style.cssText = `color:${color};font-weight:600`;
  btn.textContent = `▼ ${label}`;

  const body = document.createElement("div");
  body.style.cssText = "display:none;margin-top:8px";
  for (const f of files) body.appendChild(buildQaFileRow(f));

  let open = false;
  btn.onclick = () => {
    open = !open;
    body.style.display = open ? "block" : "none";
    btn.textContent = `${open ? "▲" : "▼"} ${label}`;
  };

  wrap.appendChild(btn);
  wrap.appendChild(body);
  return wrap;
}

// ── Okapi Rainbow project card ──────────────────────────────────────────
function buildRainbowFixCard() {
  const card = document.createElement("div");
  card.className = "step-card";
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <strong>🌈 Fix encoding with Okapi Rainbow</strong>
      <span class="badge" id="rnbBadge">confirm</span>
    </div>
    <p class="log-line" style="margin:6px 0 0">Automatically detects problematic files as soon as the output QA step finds errors, and groups them into 3 fileSets by issue type — same as the desktop app.</p>
    <p class="log-line" style="margin:4px 0 0;color:#854f0b">This runs on a server, so it can't launch Rainbow on your computer directly like the desktop app does — download the generated .rnb below and open it in your local Rainbow install instead.</p>

    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <label style="font-size:11px;color:#5f5e5a;display:block;margin-bottom:2px">Local path where you'll extract the output files</label>
        <input type="text" id="rnbLocalRoot" class="text-input" style="width:280px;margin:0" placeholder="C:\\LocProject\\output">
      </div>
      <button class="primary" id="rnbGenerateBtn" style="width:auto;margin:0">Re-detect / regenerate</button>
      <button id="rnbSkipBtn" style="margin:0">Skip</button>
    </div>
    <div id="rnbResult" style="margin-top:12px"></div>
  `;

  async function generateProject() {
    const localRoot = card.querySelector("#rnbLocalRoot").value.trim();
    const resBox = card.querySelector("#rnbResult");
    resBox.innerHTML = `<p class="log-line"><span class="spinner"></span>Detecting problematic files…</p>`;

    const res = await fetch(`/runs/${currentRunId}/steps/rainbow-fix/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localRoot })
    });
    const data = await res.json();
    if (!res.ok) { resBox.innerHTML = `<p class="log-line" style="color:#791f1f">${escapeHtml(data.error || "Failed")}</p>`; return; }

    const result = data.result;
    card.querySelector("#rnbBadge").textContent = result.skipped ? "failed" : "done";
    card.querySelector("#rnbBadge").className = `badge ${result.skipped ? "failed" : "done"}`;
    renderRainbowResult(resBox, result);
  }

  card.querySelector("#rnbGenerateBtn").onclick = generateProject;
  triggerRainbowGenerate = generateProject; // exposed so Output QA can call this automatically

  card.querySelector("#rnbSkipBtn").onclick = async () => {
    await fetch(`/runs/${currentRunId}/steps/rainbow_fix/skip`, { method: "POST" });
    card.querySelector("#rnbBadge").textContent = "skipped";
    card.querySelector("#rnbBadge").className = "badge";
    card.querySelector("#rnbResult").innerHTML = `<p class="log-line">Step skipped.</p>`;
  };

  return card;
}

function renderRainbowResult(container, result) {
  container.innerHTML = "";

  if (result.skipped) {
    container.innerHTML = `<p class="log-line" style="color:#854f0b">${escapeHtml((result.reason || "skipped").replace(/_/g, " "))}</p>`;
    return;
  }

  const summary = document.createElement("p");
  summary.className = "summary-line";
  summary.textContent = `${result.file_count} file(s) queued — fileSet 1 = encoding · fileSet 2 = EOL/BOM · fileSet 3 = both`;
  container.appendChild(summary);

  const groupDefs = [
    { key: "encoding_only", label: "fileSet 1 — Encoding issues only", color: "#185fa5" },
    { key: "eol_only", label: "fileSet 2 — EOL / BOM issues only", color: "#854f0b" },
    { key: "both", label: "fileSet 3 — Encoding + EOL/BOM", color: "#791f1f" }
  ];
  for (const g of groupDefs) {
    const files = result.groups[g.key];
    if (!files || files.length === 0) continue;
    container.appendChild(buildCollapsibleFileGroup(`${g.label} (${files.length} file${files.length !== 1 ? "s" : ""})`, files.map(f => f.file), false));
  }

  const note = document.createElement("div");
  note.style.cssText = "background:#1e1e1e;border-radius:6px;padding:10px 14px;margin-top:12px";
  note.innerHTML = `<p style="color:#9cdcfe;font-size:11px;font-family:ui-monospace,monospace;margin:0 0 4px">// How this works</p>
    <p style="color:#d4d4d4;font-size:11px;font-family:ui-monospace,monospace;margin:0;line-height:1.6">
      1. Download the output files below and extract to <span style="color:#ce9178">${escapeHtml(result.local_root || "the path you specified")}</span><br>
      2. Download the .rnb project file and open it in Okapi Rainbow<br>
      3. Files are pre-loaded into 3 fileSets by issue type<br>
      4. Run "Format Conversion" in Rainbow to apply the fix
    </p>`;
  container.appendChild(note);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;margin-top:10px";

  const downloadRnbBtn = document.createElement("button");
  downloadRnbBtn.className = "primary";
  downloadRnbBtn.style.width = "auto";
  downloadRnbBtn.textContent = "↓ Download .rnb project file";
  downloadRnbBtn.onclick = () => {
    const blob = new Blob([result.rnb_content], { type: "application/xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "loc-toolkit-rainbow.rnb";
    a.click();
  };
  btnRow.appendChild(downloadRnbBtn);

  const downloadFilesBtn = document.createElement("button");
  downloadFilesBtn.textContent = "↓ Download output files (.zip)";
  downloadFilesBtn.onclick = () => { window.location.href = `/runs/${currentRunId}/steps/output-qa/download`; };
  btnRow.appendChild(downloadFilesBtn);

  container.appendChild(btnRow);
}
