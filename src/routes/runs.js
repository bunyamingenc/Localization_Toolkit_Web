const express = require("express");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const multer = require("multer");
const { safeExtract } = require("../lib/safeExtract");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { createPendingSteps } = require("../lib/pipelineRunner");
const { enqueueRun } = require("../lib/queue");
const { isS3Reference, materializeToLocal } = require("../lib/storage");
const renamer = require("../steps/renamer");
const outputEncodingQA = require("../steps/outputEncodingQA");
const rainbowFix = require("../steps/rainbowFix");
const { LOCALE_FORMATS } = require("../steps/localeFormats");

const router = express.Router();
const now = () => new Date().toISOString();

// Separate storage tree for step-scoped uploads — e.g. the translated
// files a user gets back from Trados, which are a distinct deliverable
// from the original source project uploaded at the start.
const STEP_UPLOADS_ROOT = path.join(__dirname, "../../storage/step-uploads");
const SCRATCH_ROOT = path.join(__dirname, "../../storage/scratch");
fs.mkdirSync(STEP_UPLOADS_ROOT, { recursive: true });
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB
const stepUpload = multer({ dest: path.join(__dirname, "../../uploads"), limits: { fileSize: MAX_UPLOAD_BYTES } });

// POST /projects/:projectId/runs — start a new run (returns immediately, work happens async)
router.post("/projects/:projectId/runs", async (req, res) => {
  const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.projectId]);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const runId = uuid();
  await db.run("INSERT INTO runs (id, project_id, status) VALUES (?, ?, 'running')", [runId, project.id]);
  await createPendingSteps(runId, uuid);

  res.status(202).json({ runId, status: "running" });

  enqueueRun(runId, project).catch(async (err) => {
    await db.run("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?", [now(), runId]);
    console.error(`[run ${runId}] failed to enqueue:`, err.message);
  });
});

// GET /runs/:id — poll for status + all step results
router.get("/runs/:id", async (req, res) => {
  const run = await db.get("SELECT * FROM runs WHERE id = ?", [req.params.id]);
  if (!run) return res.status(404).json({ error: "Run not found" });

  const orderCol = db.usingPostgres ? "seq" : "rowid";
  const rawSteps = await db.all(`SELECT * FROM steps WHERE run_id = ? ORDER BY ${orderCol}`, [run.id]);
  const steps = rawSteps.map((s) => ({ ...s, result: s.result_json ? JSON.parse(s.result_json) : null }));

  res.json({ ...run, steps });
});

// Insert-or-update a single step row and return its id. Used by the
// interactive steps below, which run on-demand rather than as part of
// the automatic pipeline.
async function upsertStep(runId, stepKey, status, resultJson) {
  const existing = await db.get("SELECT id FROM steps WHERE run_id = ? AND step_key = ?", [runId, stepKey]);
  if (existing) {
    await db.run("UPDATE steps SET status = ?, result_json = ?, finished_at = ? WHERE id = ?", [status, resultJson, now(), existing.id]);
    return existing.id;
  }
  const id = uuid();
  await db.run(
    "INSERT INTO steps (id, run_id, step_key, status, result_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, runId, stepKey, status, resultJson, now(), now()]
  );
  return id;
}

// Like upsertStep, but merges into any existing result_json instead of
// overwriting it — needed here because output QA collects two independent
// uploads (output folder, then optionally source folder) before running.
async function mergeStepResult(runId, stepKey, status, patch) {
  const existing = await db.get("SELECT id, result_json FROM steps WHERE run_id = ? AND step_key = ?", [runId, stepKey]);
  let merged = patch;
  if (existing?.result_json) {
    try { merged = { ...JSON.parse(existing.result_json), ...patch }; } catch {}
  }
  const resultJson = JSON.stringify(merged);
  if (existing) {
    await db.run("UPDATE steps SET status = ?, result_json = ?, finished_at = ? WHERE id = ?", [status, resultJson, now(), existing.id]);
    return existing.id;
  }
  const id = uuid();
  await db.run(
    "INSERT INTO steps (id, run_id, step_key, status, result_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, runId, stepKey, status, resultJson, now(), now()]
  );
  return id;
}

async function getProjectForRun(runId) {
  const run = await db.get("SELECT * FROM runs WHERE id = ?", [runId]);
  if (!run) return null;
  return db.get("SELECT * FROM projects WHERE id = ?", [run.project_id]);
}

// GET /locale-formats — naming format presets for the renamer's format picker
router.get("/locale-formats", (req, res) => {
  res.json(LOCALE_FORMATS);
});

// POST /runs/:runId/steps/cat-import — marks the manual Trados step done,
// recording which locales the user targeted. No brief text is generated —
// the actual project setup happens entirely inside Trados, outside this tool.
router.post("/runs/:runId/steps/cat-import", async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { sourceLocale, locales } = req.body || {};
  const result = { source_locale: sourceLocale || null, locales: locales || [] };

  await upsertStep(req.params.runId, "cat_import", "done", JSON.stringify(result));
  res.json({ result });
});

// POST /runs/:runId/steps/:stepKey/skip — generic skip for any interactive step
router.post("/runs/:runId/steps/:stepKey/skip", async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  await upsertStep(req.params.runId, req.params.stepKey, "skipped", JSON.stringify({ skipped: true, reason: "user_skipped" }));
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
  await upsertStep(req.params.runId, "renamer", "awaiting_confirmation", JSON.stringify({ root_upload_path: extractPath }));
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

async function resolveRenamerRoot(req, project) {
  const { rootPath, rootSubpath } = req.body || {};
  const safeExplicit = resolveSafeRoot(rootPath);
  if (safeExplicit) return safeExplicit;

  // Fall back to whatever was uploaded via upload-root for this step, if any
  const existing = await db.get("SELECT result_json FROM steps WHERE run_id = ? AND step_key = 'renamer'", [req.params.runId]);
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
  const project = await getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { formatId, skipAssets, excludeLocales, sourceLocale, locales } = req.body || {};
  const rootPath = await resolveRenamerRoot(req, project);

  const result = await renamer.run(rootPath, {
    formatId, skipAssets, excludeLocales, sourceLocale, locales, dryRun: true
  });

  await upsertStep(req.params.runId, "renamer", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

// POST /runs/:runId/steps/renamer/apply — actually renames files inside
// the resolved root folder (either the uploaded translated-files zip, or
// the original project's storage — both server-side, safe to modify).
// Use GET /projects/:id/download afterward to retrieve as a zip.
router.post("/runs/:runId/steps/renamer/apply", async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const { formatId, skipAssets, excludeLocales, sourceLocale, locales } = req.body || {};
  const rootPath = await resolveRenamerRoot(req, project);

  const result = await renamer.run(rootPath, {
    formatId, skipAssets, excludeLocales, sourceLocale, locales, dryRun: false
  });

  await upsertStep(req.params.runId, "renamer", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

// GET /projects/:id/download — zips the project's current storage folder
// (reflecting any renames already applied) and streams it back. Works
// identically for local-disk and S3-backed projects — S3 ones are
// materialized to a scratch folder first, then cleaned up after.
router.get("/projects/:id/download", async (req, res) => {
  const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
  if (!project) return res.status(404).json({ error: "Project not found" });

  let downloadPath = project.storage_path;
  let scratchDir = null;
  if (isS3Reference(downloadPath)) {
    scratchDir = path.join(SCRATCH_ROOT, uuid());
    await materializeToLocal(downloadPath, scratchDir);
    downloadPath = scratchDir;
  }

  if (!fs.existsSync(downloadPath)) return res.status(404).json({ error: "Project files not found" });

  res.attachment(`${project.name.replace(/[^a-z0-9_-]/gi, "_")}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(err.message));
  const cleanup = () => { if (scratchDir && fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true }); };
  res.on("finish", cleanup);
  res.on("close", cleanup);
  archive.pipe(res);
  archive.directory(downloadPath, false);
  archive.finalize();
});

// GET /runs/:runId/steps/renamer/download — zips whichever folder the
// renamer last operated on (uploaded translated-files folder, or the
// original project) and streams it back.
router.get("/runs/:runId/steps/renamer/download", async (req, res) => {
  const stepRow = await db.get("SELECT result_json FROM steps WHERE run_id = ? AND step_key = 'renamer'", [req.params.runId]);
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

async function jsonSafeGet(runId, stepKey) {
  const row = await db.get("SELECT result_json FROM steps WHERE run_id = ? AND step_key = ?", [runId, stepKey]);
  if (!row?.result_json) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

// Output folder priority: explicitly uploaded for this step > the
// renamer's resolved root (files just got renamed, this checks them) >
// the original uploaded project as a last resort.
async function resolveOutputRoot(runId, project) {
  const stored = await jsonSafeGet(runId, "output_encoding_qa");
  if (stored?.output_upload_path && fs.existsSync(stored.output_upload_path)) return stored.output_upload_path;

  const renamerResult = await jsonSafeGet(runId, "renamer");
  if (renamerResult?.root_folder && fs.existsSync(renamerResult.root_folder)) return renamerResult.root_folder;

  return project.storage_path;
}

// Source folder: explicitly uploaded override > the original project
// (auto-used by default, per your instruction).
async function resolveSourceRoot(runId, project) {
  const stored = await jsonSafeGet(runId, "output_encoding_qa");
  if (stored?.source_upload_path && fs.existsSync(stored.source_upload_path)) return stored.source_upload_path;
  return project.storage_path;
}

// POST /runs/:runId/steps/output-qa/upload-output — choose the folder to check
router.post("/runs/:runId/steps/output-qa/upload-output", stepUpload.single("file"), async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
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

  await mergeStepResult(req.params.runId, "output_encoding_qa", "awaiting_confirmation", { output_upload_path: extractPath });
  res.json({ path: extractPath });
});

// POST /runs/:runId/steps/output-qa/upload-source — optional override for the
// comparison baseline; without this, the original project is used automatically.
router.post("/runs/:runId/steps/output-qa/upload-source", stepUpload.single("file"), async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
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

  await mergeStepResult(req.params.runId, "output_encoding_qa", "awaiting_confirmation", { source_upload_path: extractPath });
  res.json({ path: extractPath });
});

// POST /runs/:runId/steps/output-qa/run — runs the actual comparison
router.post("/runs/:runId/steps/output-qa/run", async (req, res) => {
  const project = await getProjectForRun(req.params.runId);
  if (!project) return res.status(404).json({ error: "Run or project not found" });

  const outputFolder = await resolveOutputRoot(req.params.runId, project);
  const sourceFolder = await resolveSourceRoot(req.params.runId, project);

  const result = await outputEncodingQA.run(outputFolder, sourceFolder);

  await mergeStepResult(req.params.runId, "output_encoding_qa", result.skipped ? "failed" : "done", result);
  res.json({ result });
});

// GET /runs/:runId/steps/output-qa/download — zips whatever folder was
// actually checked, so it lines up with the paths referenced in a
// generated Rainbow .rnb project.
router.get("/runs/:runId/steps/output-qa/download", async (req, res) => {
  const stored = await jsonSafeGet(req.params.runId, "output_encoding_qa");
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
  const qaResult = await jsonSafeGet(req.params.runId, "output_encoding_qa");
  if (!qaResult) return res.status(400).json({ error: "Run the output encoding QA step first." });

  const errorFiles = (qaResult.issues || []).filter(f => f.issues.some(i => i.severity === "error"));
  const { targetEncoding, localRoot, sourceLanguage, targetLanguage } = req.body || {};

  const result = await rainbowFix.run(errorFiles, targetEncoding, localRoot, sourceLanguage, targetLanguage);

  await upsertStep(req.params.runId, "rainbow_fix", result.skipped ? "failed" : "done", JSON.stringify(result));
  res.json({ result });
});

module.exports = router;
