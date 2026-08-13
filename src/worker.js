/**
 * Standalone queue worker. Only meaningful when REDIS_URL is set — run
 * this as its own process (or container, or serverless function) separate
 * from the API server, so you can scale API instances and pipeline
 * workers independently.
 *
 *   REDIS_URL=redis://... npm run worker
 *
 * If REDIS_URL isn't set, this exits immediately with a message — there's
 * nothing to consume, since queue.js falls back to running the pipeline
 * in-process inside the API server itself in that case.
 */
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.log("[worker] No REDIS_URL set — nothing to do. The API server runs the pipeline in-process without a separate worker.");
  process.exit(0);
}

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { processRun } = require("./lib/pipelineRunner");
const db = require("./db/db");

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(
  "loc-toolkit-runs",
  async (job) => {
    const { runId, project } = job.data;
    console.log(`[worker] processing run ${runId}`);
    await processRun(runId, project);
  },
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) }
);

worker.on("failed", (job, err) => {
  const runId = job?.data?.runId;
  console.error(`[worker] run ${runId} failed:`, err.message);
  if (runId) {
    db.run("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), runId])
      .catch((e) => console.error(`[worker] could not mark run ${runId} failed in db:`, e.message));
  }
});

worker.on("completed", (job) => {
  console.log(`[worker] run ${job.data.runId} completed`);
});

console.log("[worker] listening for jobs on queue 'loc-toolkit-runs'");
