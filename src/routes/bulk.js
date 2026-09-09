/**
 * Bulk Operations — process multiple projects in one request.
 * 
 * POST /api/bulk/process
 * {
 *   "operations": [
 *     { "projectId": "uuid", "targets": ["de", "fr", "es"] },
 *     { "projectId": "uuid", "targets": ["ja", "ko"] }
 *   ],
 *   "webhookUrl": "https://my-tms.com/callback" (optional)
 * }
 * 
 * Returns immediately with a bulkJobId.
 * Each operation is enqueued separately, but all share the same bulkJobId for tracking.
 * Webhooks fire individually per run, but include bulkJobId in payload for correlation.
 */

const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { enqueueRun } = require("../lib/queue");
const { createPendingSteps } = require("../lib/pipelineRunner");
const { registerWebhook } = require("../lib/webhooks");

const router = express.Router();
const now = () => new Date().toISOString();

/**
 * POST /bulk/process
 * 
 * Submit multiple projects to process in bulk.
 * Each project gets its own run, but all runs share a bulkJobId.
 */
router.post("/process", async (req, res) => {
  const { operations, webhookUrl } = req.body || {};

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return res.status(400).json({
      error: "Invalid request. Provide 'operations' array with at least one operation.",
      example: {
        operations: [
          { projectId: "uuid", targets: ["de", "fr"] },
        ],
        webhookUrl: "https://optional-callback-url.com/webhook",
      },
    });
  }

  const bulkJobId = uuid();
  const createdAt = now();
  const operationCount = operations.length;

  try {
    // Create bulk job record for tracking
    await db.run(
      `INSERT INTO bulk_jobs (id, operation_count, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [bulkJobId, operationCount, "running", createdAt]
    );

    // If webhook URL provided, register it for this bulk job
    let webhookId = null;
    if (webhookUrl) {
      const webhook = await registerWebhook(null, webhookUrl); // null projectId = bulk job level
      webhookId = webhook.id;
      await db.run(
        `UPDATE webhooks SET bulk_job_id = ? WHERE id = ?`,
        [bulkJobId, webhookId]
      );
    }

    // Enqueue each operation as a separate run
    const runIds = [];
    const failedOps = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const { projectId, targets } = op;

      if (!projectId) {
        failedOps.push({ index: i, error: "projectId is required" });
        continue;
      }

      try {
        const project = await db.get("SELECT * FROM projects WHERE id = ?", [projectId]);
        if (!project) {
          failedOps.push({ index: i, error: `Project ${projectId} not found` });
          continue;
        }

        const runId = uuid();
        await db.run(
          `INSERT INTO runs (id, project_id, status, bulk_job_id) VALUES (?, ?, ?, ?)`,
          [runId, projectId, "running", bulkJobId]
        );

        // Store targets if provided (for context/logging)
        if (targets && Array.isArray(targets)) {
          await db.run(
            `INSERT INTO run_metadata (run_id, key, value) VALUES (?, ?, ?)`,
            [runId, "bulk_targets", JSON.stringify(targets)]
          );
        }

        await createPendingSteps(runId, uuid);
        runIds.push(runId);

        // Enqueue the run asynchronously
        enqueueRun(runId, project).catch(async (err) => {
          await db.run(
            `UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?`,
            [now(), runId]
          );
          console.error(`[bulk ${bulkJobId}] run ${runId} failed to enqueue:`, err.message);
        });
      } catch (err) {
        failedOps.push({ index: i, error: err.message });
      }
    }

    // Return immediately with bulk job status
    const response = {
      bulkJobId,
      status: "accepted",
      operationCount: operations.length,
      successCount: runIds.length,
      failedCount: failedOps.length,
      runIds,
      failedOperations: failedOps.length > 0 ? failedOps : undefined,
      _links: {
        status: `/bulk/jobs/${bulkJobId}`,
        runs: runIds.map((id) => ({ runId: id, href: `/runs/${id}` })),
      },
    };

    res.status(202).json(response);
  } catch (err) {
    await db.run(
      `UPDATE bulk_jobs SET status = 'failed', completed_at = ? WHERE id = ?`,
      [now(), bulkJobId]
    );
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /bulk/jobs/:bulkJobId
 * 
 * Poll for status of a bulk job and all its runs.
 */
router.get("/jobs/:bulkJobId", async (req, res) => {
  const job = await db.get("SELECT * FROM bulk_jobs WHERE id = ?", [req.params.bulkJobId]);
  if (!job) return res.status(404).json({ error: "Bulk job not found" });

  const runs = await db.all(
    "SELECT id, project_id, status, created_at, updated_at FROM runs WHERE bulk_job_id = ? ORDER BY created_at ASC",
    [job.id]
  );

  const statuses = {
    running: runs.filter((r) => r.status === "running").length,
    succeeded: runs.filter((r) => r.status === "succeeded").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };

  const allDone = statuses.running === 0;
  const overallStatus = allDone
    ? statuses.failed === 0
      ? "succeeded"
      : "partial"
    : "running";

  res.json({
    id: job.id,
    status: overallStatus,
    createdAt: job.created_at,
    completedAt: job.completed_at,
    operationCount: job.operation_count,
    statuses,
    runs: runs.map((r) => ({
      runId: r.id,
      projectId: r.project_id,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      _href: `/runs/${r.id}`,
    })),
  });
});

/**
 * GET /bulk/jobs
 * 
 * List all bulk jobs (most recent first).
 */
router.get("/jobs", async (req, res) => {
  const jobs = await db.all(
    `SELECT id, operation_count, status, created_at, completed_at
     FROM bulk_jobs ORDER BY created_at DESC LIMIT 100`,
    []
  );
  res.json(jobs);
});

module.exports = router;
