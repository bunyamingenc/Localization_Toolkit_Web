const db = require("../db/db");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const inventory = require("../steps/inventory");
const encodingQA = require("../steps/encodingQA");
const placeholderAnalysis = require("../steps/placeholderAnalysis");
const { isS3Reference, materializeToLocal } = require("./storage");
const { notifyWebhooksForRun } = require("./webhooks");

const SCRATCH_ROOT = path.join(__dirname, "../../storage/scratch");
const now = () => new Date().toISOString();

// Pipeline order — matches desktop app: inventory -> encoding QA -> placeholder analysis
const PIPELINE = ["inventory", "encoding_qa", "placeholder_analysis"];

const STEP_RUNNERS = {
  inventory: (project) => inventory.run(project.storage_path),
  encoding_qa: (project) => encodingQA.run(project.storage_path),
  placeholder_analysis: (project) => placeholderAnalysis.run(project.storage_path),
};

/**
 * Creates the pending step rows for a new run. Called synchronously right
 * after the run row itself is inserted, before any actual work starts.
 */
async function createPendingSteps(runId, uuidFn) {
  for (const stepKey of PIPELINE) {
    await db.run("INSERT INTO steps (id, run_id, step_key, status) VALUES (?, ?, ?, 'pending')", [uuidFn(), runId, stepKey]);
  }
}

/**
 * Runs the automatic pipeline steps in order, updating step/run status as
 * it goes. This is the actual work — identical whether it's invoked
 * in-process (no Redis configured, simplest deployment) or picked up by a
 * separate BullMQ worker process (real queue, see queue.js/worker.js).
 */
async function processRun(runId, project) {
  // If the project lives in S3, download it to a local scratch directory
  // first — every step function reads via fs.readdirSync/readFileSync and
  // has no idea S3 exists. This keeps all step logic completely unchanged
  // regardless of which storage backend is configured.
  let workingProject = project;
  let scratchDir = null;
  if (isS3Reference(project.storage_path)) {
    scratchDir = path.join(SCRATCH_ROOT, uuid());
    await materializeToLocal(project.storage_path, scratchDir);
    workingProject = { ...project, storage_path: scratchDir };
  }

  try {
    // steps.id is a UUID (TEXT), so ORDER BY id sorts alphabetically, not
    // by insertion order. SQLite's implicit rowid always reflects
    // insertion order; Postgres has no rowid, so the schema adds an
    // explicit "seq" auto-increment column there instead.
    const orderCol = db.usingPostgres ? "seq" : "rowid";
    const steps = await db.all(`SELECT * FROM steps WHERE run_id = ? ORDER BY ${orderCol}`, [runId]);

    for (const step of steps) {
      await db.run("UPDATE steps SET status = 'running', started_at = ? WHERE id = ?", [now(), step.id]);
      try {
        const result = await STEP_RUNNERS[step.step_key](workingProject);
        await db.run("UPDATE steps SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?", [JSON.stringify(result), now(), step.id]);
      } catch (err) {
        await db.run("UPDATE steps SET status = 'failed', result_json = ?, finished_at = ? WHERE id = ?", [JSON.stringify({ error: err.message }), now(), step.id]);
        await db.run("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?", [now(), runId]);
        const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
        notifyWebhooksForRun(project.id, runId, API_BASE_URL).catch((e) => console.error(`[webhooks] notify failed for run ${runId}:`, e.message));
        return;
      }
    }

    await db.run("UPDATE runs SET status = 'done', updated_at = ? WHERE id = ?", [now(), runId]);
    const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
    notifyWebhooksForRun(project.id, runId, API_BASE_URL).catch((e) => console.error(`[webhooks] notify failed for run ${runId}:`, e.message));
  } finally {
    // These pipeline steps (inventory/encoding QA/placeholder analysis)
    // are read-only scans — nothing needs to be synced back to S3, so the
    // scratch copy is just discarded once they're done.
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

module.exports = { PIPELINE, STEP_RUNNERS, createPendingSteps, processRun };
