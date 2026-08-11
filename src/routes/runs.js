const express = require("express");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const multer = require("multer");
const { safeExtract } = require("../lib/safeExtract");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const inventory = require("../steps/inventory");
const encodingQA = require("../steps/encodingQA");
const placeholderAnalysis = require("../steps/placeholderAnalysis");
const renamer = require("../steps/renamer");
const outputEncodingQA = require("../steps/outputEncodingQA");
const rainbowFix = require("../steps/rainbowFix");
const { LOCALE_FORMATS } = require("../steps/localeFormats");

const router = express.Router();

// Separate storage tree for step-scoped uploads — e.g. the translated
// files a user gets back from Trados, which are a distinct deliverable
// from the original source project uploaded at the start.
const STEP_UPLOADS_ROOT = path.join(__dirname, "../../storage/step-uploads");
fs.mkdirSync(STEP_UPLOADS_ROOT, { recursive: true });
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB
const stepUpload = multer({ dest: path.join(__dirname, "../../uploads"), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Pipeline order — matches desktop app: inventory -> encoding QA -> placeholder analysis
const PIPELINE = ["inventory", "encoding_qa", "placeholder_analysis"];

const STEP_RUNNERS = {
  inventory: (project) => inventory.run(project.storage_path),
  encoding_qa: (project) => encodingQA.run(project.storage_path),
  placeholder_analysis: (project) => placeholderAnalysis.run(project.storage_path),
};

// POST /projects/:projectId/runs — start a new run (returns immediately, work happens async)
router.post("/projects/:projectId/runs", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const runId = uuid();
  db.prepare("INSERT INTO runs (id, project_id, status) VALUES (?, ?, 'running')").run(runId, project.id);

  for (const stepKey of PIPELINE) {
    db.prepare("INSERT INTO steps (id, run_id, step_key, status) VALUES (?, ?, ?, 'pending')")
      .run(uuid(), runId, stepKey);
  }

  res.status(202).json({ runId, status: "running" });

  processRun(runId, project).catch((err) => {
    db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(runId);
    console.error(`[run ${runId}] failed:`, err.message);
  });
});

async function processRun(runId, project) {
  // ORDER BY rowid — steps.id is a UUID (TEXT), so ORDER BY id sorts
  // alphabetically, not by insertion order. rowid is SQLite's implicit
  // auto-incrementing column and always reflects insertion order.
  const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(runId);

  for (const step of steps) {
    db.prepare("UPDATE steps SET status = 'running', started_at = datetime('now') WHERE id = ?").run(step.id);
    try {
      const result = await STEP_RUNNERS[step.step_key](project);
      db.prepare("UPDATE steps SET status = 'done', result_json = ?, finished_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(result), step.id);
    } catch (err) {
      db.prepare("UPDATE steps SET status = 'failed', result_json = ?, finished_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify({ error: err.message }), step.id);
      db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(runId);
      return;
    }
  }

  db.prepare("UPDATE runs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(runId);
}

// GET /runs/:id — poll for status + all step results
router.get("/runs/:id", (req, res) => {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });

  const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(run.id)
    .map((s) => ({ ...s, result: s.result_json ? JSON.parse(s.result_json) : null }));

  res.json({ ...run, steps });
});

// Insert-or-update a single step row synchronously and return its id.
// Used by the interactive steps below, which run on-demand rather than as
// part of the automatic pipeline.
function upsertStep(runId, stepKey, status, resultJson) {
  const existing = db.prepare("SELECT id FROM steps WHERE run_id = ? AND step_key = ?").get(runId, stepKey);
  if (existing) {
    db.prepare("UPDATE steps SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, resultJson, existing.id);
    return existing.id;
  }
  const id = uuid();
  db.prepare("INSERT INTO steps (id, run_id, step_key, status, result_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))")
    .run(id, runId, stepKey, status, resultJson);
  return id;
}

// Like upsertStep, but merges into any existing result_json instead of
// overwriting it — needed here because output QA collects two independent
// uploads (output folder, then optionally source folder) before running.
function mergeStepResult(runId, stepKey, status, patch) {
  const existing = db.prepare("SELECT id, result_json FROM steps WHERE run_id = ? AND step_key = ?").get(runId, stepKey);
  let merged = patch;
  if (existing?.result_json) {
    try { merged = { ...JSON.parse(existing.result_json), ...patch }; } catch {}
  }
  const resultJson = JSON.stringify(merged);
  if (existing) {
    db.prepare("UPDATE steps SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, resultJson, existing.id);
    return existing.id;
  }
  const id = uuid();
  db.prepare("INSERT INTO steps (id, run_id, step_key, status, result_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))")
    .run(id, runId, stepKey, status, resultJson);
  return id;
}

function getProjectForRun(runId) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) return null;
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(run.project_id);
}

// GET /locale-formats — naming format presets for the renamer's format picker
router.get("/locale-formats", (req, res) => {
  res.json(LOCALE_FORMATS);
});

// POST /runs/:runId/steps/cat-import — marks the manual Trados step done,
// recording which locales the user targeted. No brief text is generated —
// the actual project setup happens entirely inside Trados, outside this tool.
router.post("/runs/:runId/steps/cat-import", (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { sourceLocale, locales } = req.body || {};
  const result = { source_locale: sourceLocale || null, locales: locales || [] };

  upsertStep(req.params.runId, "cat_import", "done", JSON.stringify(result));
  res.json({ result });
});

// POST /runs/:runId/steps/:stepKey/skip — generic skip for any interactive step
router.post("/runs/:runId/steps/:stepKey/skip", (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  upsertStep(req.params.runId, req.params.stepKey, "skipped", JSON.stringify({ skipped: true, reason: "user_skipped" }));
  res.json({ ok: true });
});

// POST /runs/:runId/steps/renamer/upload-root — upload a NEW zip of
// translated files (what came back from Trados) to use as the renamer's
// working folder, distinct from the original source project.
router.post("/runs/:runId/steps/renamer/upload-root", stepUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Send a zip under field name 'file'." });

  const extractPath = path.join(STEP_UPLOADS_ROOT, uuid());

  try {
    await safeExtract(req.file.path, extractPath);
  } catch (err) {
    return res.status(400).json({ error: `Could not extract zip: ${err.message}` });
  } finally {
    fs.unlinkSync(req.file.path);
  }

  // Record it against the step so a later preview/apply without an explicit
  // rootPath still knows where to look.
  upsertStep(req.params.runId, "renamer", "awaiting_confirmation", JSON.stringify({ root_upload_path: extractPath }));
  res.json({ path: extractPath });
});

// Only ever resolve rootPath to somewhere inside our own storage tree —
// a client-supplied absolute path is only ever one we handed out ourselves
// via the upload-root endpoint above, but this guards against tampering.
function resolveSafeRoot(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  const storageRoot = path.resolve(path.join(__dirname, "../../storage"));
  return resolved.startsWith(storageRoot) ? resolved : null;
}

function resolveRenamerRoot(req, project) {
  const { rootPath, rootSubpath } = req.body || {};
  const safeExplicit = resolveSafeRoot(rootPath);
  if (safeExplicit) return safeExplicit;

  // Fall back to whatever was uploaded via upload-root for this step, if any
  const existing = db.prepare("SELECT result_json FROM steps WHERE run_id = ? AND step_key = 'renamer'").get(req.params.runId);
  if (existing?.result_json) {
    try {
      const prev = JSON.parse(existing.result_json);
      if (prev.root_upload_path) return prev.root_upload_path;
    } catch {}
  }

  return rootSubpath ? path.join(project.storage_path, rootSubpath) : project.storage_path;
}

// POST /runs/:runId/steps/renamer/preview — dry-run only, never writes to disk
router.post("/runs/:runId/steps/renamer/preview", async (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { formatId, skipAssets, excludeLocales, sourceLocale, locales } = req.body || {};
  const rootPath = resolveRenamerRoot(req, project);

  const result = await renamer.run(rootPath, {
    formatId, skipAssets, excludeLocales, sourceLocale, locales, dryRun: true
  });

  upsertStep(req.params.runId, "renamer", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

// POST /runs/:runId/steps/renamer/apply — actually renames files inside
// the resolved root folder (either the uploaded translated-files zip, or
// the original project's storage — both server-side, safe to modify).
// Use GET /projects/:id/download afterward to retrieve as a zip.
router.post("/runs/:runId/steps/renamer/apply", async (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { formatId, skipAssets, excludeLocales, sourceLocale, locales } = req.body || {};
  const rootPath = resolveRenamerRoot(req, project);

  const result = await renamer.run(rootPath, {
    formatId, skipAssets, excludeLocales, sourceLocale, locales, dryRun: false
  });

  upsertStep(req.params.runId, "renamer", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

// GET /projects/:id/download — zips the project's current storage folder
// (reflecting any renames already applied) and streams it back.
router.get("/projects/:id/download", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!fs.existsSync(project.storage_path)) return res.status(404).json({ error: "Project files not found" });

  res.attachment(`${project.name.replace(/[^a-z0-9_-]/gi, "_")}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(project.storage_path, false);
  archive.finalize();
});

// GET /runs/:runId/steps/renamer/download — zips whichever folder the
// renamer last operated on (uploaded translated-files folder, or the
// original project) and streams it back.
router.get("/runs/:runId/steps/renamer/download", (req, res) => {
  const stepRow = db.prepare("SELECT result_json FROM steps WHERE run_id = ? AND step_key = 'renamer'").get(req.params.runId);
  if (!stepRow?.result_json) return res.status(404).json({ error: "No renamer result for this run yet" });

  let rootFolder;
  try { rootFolder = JSON.parse(stepRow.result_json).root_folder; } catch { rootFolder = null; }
  if (!rootFolder || !fs.existsSync(rootFolder)) return res.status(404).json({ error: "Renamed files not found" });

  res.attachment("renamed-files.zip");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(rootFolder, false);
  archive.finalize();
});

// ── Output encoding & line-ending QA ────────────────────────────────────

function jsonSafeGet(runId, stepKey) {
  const row = db.prepare("SELECT result_json FROM steps WHERE run_id = ? AND step_key = ?").get(runId, stepKey);
  if (!row?.result_json) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

// Output folder priority: explicitly uploaded for this step > the
// renamer's resolved root (files just got renamed, this checks them) >
// the original uploaded project as a last resort.
function resolveOutputRoot(runId, project) {
  const stored = jsonSafeGet(runId, "output_encoding_qa");
  if (stored?.output_upload_path && fs.existsSync(stored.output_upload_path)) return stored.output_upload_path;

  const renamerResult = jsonSafeGet(runId, "renamer");
  if (renamerResult?.root_folder && fs.existsSync(renamerResult.root_folder)) return renamerResult.root_folder;

  return project.storage_path;
}

// Source folder: explicitly uploaded override > the original project
// (auto-used by default, per your instruction).
function resolveSourceRoot(runId, project) {
  const stored = jsonSafeGet(runId, "output_encoding_qa");
  if (stored?.source_upload_path && fs.existsSync(stored.source_upload_path)) return stored.source_upload_path;
  return project.storage_path;
}

// POST /runs/:runId/steps/output-qa/upload-output — choose the folder to check
router.post("/runs/:runId/steps/output-qa/upload-output", stepUpload.single("file"), async (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const extractPath = path.join(STEP_UPLOADS_ROOT, uuid());
  try {
    await safeExtract(req.file.path, extractPath);
  } catch (err) {
    return res.status(400).json({ error: `Could not extract zip: ${err.message}` });
  } finally {
    fs.unlinkSync(req.file.path);
  }

  mergeStepResult(req.params.runId, "output_encoding_qa", "awaiting_confirmation", { output_upload_path: extractPath });
  res.json({ path: extractPath });
});

// POST /runs/:runId/steps/output-qa/upload-source — optional override for the
// comparison baseline; without this, the original project is used automatically.
router.post("/runs/:runId/steps/output-qa/upload-source", stepUpload.single("file"), async (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const extractPath = path.join(STEP_UPLOADS_ROOT, uuid());
  try {
    await safeExtract(req.file.path, extractPath);
  } catch (err) {
    return res.status(400).json({ error: `Could not extract zip: ${err.message}` });
  } finally {
    fs.unlinkSync(req.file.path);
  }

  mergeStepResult(req.params.runId, "output_encoding_qa", "awaiting_confirmation", { source_upload_path: extractPath });
  res.json({ path: extractPath });
});

// POST /runs/:runId/steps/output-qa/run — runs the actual comparison
router.post("/runs/:runId/steps/output-qa/run", async (req, res) => {
  const project = getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const outputFolder = resolveOutputRoot(req.params.runId, project);
  const sourceFolder = resolveSourceRoot(req.params.runId, project);

  const result = await outputEncodingQA.run(outputFolder, sourceFolder);

  mergeStepResult(req.params.runId, "output_encoding_qa", result.skipped ? "failed" : "done", result);
  res.json({ result });
});

// GET /runs/:runId/steps/output-qa/download — zips whatever folder was
// actually checked, so it lines up with the paths referenced in a
// generated Rainbow .rnb project.
router.get("/runs/:runId/steps/output-qa/download", (req, res) => {
  const stored = jsonSafeGet(req.params.runId, "output_encoding_qa");
  const outputFolder = stored?.output_folder;
  if (!outputFolder || !fs.existsSync(outputFolder)) return res.status(404).json({ error: "No output folder found — run the QA check first." });

  res.attachment("output-files.zip");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(outputFolder, false);
  archive.finalize();
});

// ── Okapi Rainbow project generation ────────────────────────────────────

// POST /runs/:runId/steps/rainbow-fix/generate — reads errors from the
// output QA step and generates a Rainbow .rnb referencing wherever the
// user says they'll extract the downloaded output files locally.
router.post("/runs/:runId/steps/rainbow-fix/generate", async (req, res) => {
  const qaResult = jsonSafeGet(req.params.runId, "output_encoding_qa");
  if (!qaResult) return res.status(400).json({ error: "Run the output encoding QA step first." });

  const errorFiles = (qaResult.issues || []).filter(f => f.issues.some(i => i.severity === "error"));
  const { targetEncoding, localRoot, sourceLanguage, targetLanguage } = req.body || {};

  const result = await rainbowFix.run(errorFiles, targetEncoding, localRoot, sourceLanguage, targetLanguage);

  upsertStep(req.params.runId, "rainbow_fix", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

module.exports = router;
