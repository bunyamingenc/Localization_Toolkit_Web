const { processRun } = require("./pipelineRunner");
const db = require("../db/db");

const REDIS_URL = process.env.REDIS_URL;
let queue = null;

if (REDIS_URL) {
  // Real queue path — requires a running worker (see worker.js) to
  // actually consume jobs. The API process only enqueues; it never runs
  // the pipeline itself once a real queue is configured, which is what
  // lets you scale API instances and worker instances independently.
  const { Queue } = require("bullmq");
  const IORedis = require("ioredis");
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue("loc-toolkit-runs", { connection });
  console.log("[queue] REDIS_URL set — using BullMQ. Run `npm run worker` in a separate process to consume jobs.");
} else {
  console.log("[queue] No REDIS_URL set — running the pipeline in-process (fine for local dev and small deployments).");
}

/**
 * Enqueues a run for processing. With a real queue configured, this adds
 * a job and returns immediately — a worker process picks it up. Without
 * one, it just calls processRun() directly, matching the original
 * in-process behavior exactly.
 */
async function enqueueRun(runId, project) {
  if (queue) {
    await queue.add("process-run", { runId, project });
  } else {
    // Fire-and-forget, same as the original implementation — the caller
    // (the HTTP route) has already responded 202 before this runs. The
    // catch here is a safety net for unexpected errors in processRun
    // itself (a bug, not a normal step failure — those are already
    // handled and recorded inside processRun).
    processRun(runId, project).catch((err) => {
      db.run("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), runId])
        .catch((e) => console.error(`[queue] could not mark run ${runId} failed in db:`, e.message));
      console.error(`[run ${runId}] failed:`, err.message);
    });
  }
}

module.exports = { enqueueRun, usingRealQueue: !!REDIS_URL };
