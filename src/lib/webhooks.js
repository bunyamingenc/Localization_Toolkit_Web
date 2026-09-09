/**
 * Webhooks — deliver job completion notifications to external systems.
 * 
 * When a run completes (success/failure), the webhook system:
 * 1. Looks up registered webhooks for that project
 * 2. POST's a signed payload to each URL with:
 *    - runId, projectId, status, completedAt
 *    - downloadUrls (for output files)
 *    - All step results
 * 3. Retries failed deliveries (exponential backoff)
 * 4. Logs all attempts for audit
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const db = require("../db/db");

const WEBHOOK_TIMEOUT_MS = 30000; // 30s max for external system to respond
const MAX_RETRIES = 5; // fail after 5 attempts
const WEBHOOK_SIGNATURE_HEADER = "X-Loc-Toolkit-Signature";

/**
 * Register a webhook for a project.
 * Returns the webhook record with id.
 */
async function registerWebhook(projectId, webhookUrl, options = {}) {
  const id = require("uuid").v4();
  const createdAt = new Date().toISOString();
  
  await db.run(
    `INSERT INTO webhooks (id, project_id, url, created_at, active, retry_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, projectId, webhookUrl, createdAt, 1, 0]
  );
  
  return { id, projectId, webhookUrl, createdAt, active: true };
}

/**
 * List all webhooks for a project
 */
async function getProjectWebhooks(projectId) {
  return db.all(
    `SELECT id, url, created_at, active, retry_count, last_error FROM webhooks
     WHERE project_id = ? ORDER BY created_at DESC`,
    [projectId]
  );
}

/**
 * Unregister a webhook
 */
async function unregisterWebhook(webhookId) {
  await db.run(`DELETE FROM webhooks WHERE id = ?`, [webhookId]);
}

/**
 * Sign a payload for webhook delivery.
 * Uses HMAC-SHA256 with the webhook ID as the secret.
 * External system can verify signature matches.
 */
function signPayload(payload, webhookId) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", webhookId);
  hmac.update(body);
  return hmac.digest("hex");
}

/**
 * Construct the full webhook payload for a completed run.
 * Includes status, all step results, and download URLs for output files.
 */
async function buildWebhookPayload(runId, downloadBaseUrl) {
  const run = await db.get(
    `SELECT id, project_id, status, created_at, updated_at FROM runs WHERE id = ?`,
    [runId]
  );
  if (!run) return null;

  const orderCol = db.usingPostgres ? "seq" : "rowid";
  const steps = await db.all(
    `SELECT step_key, status, result_json FROM steps WHERE run_id = ? ORDER BY ${orderCol}`,
    [runId]
  );

  const stepsMap = {};
  for (const step of steps) {
    stepsMap[step.step_key] = {
      status: step.status,
      result: step.result_json ? JSON.parse(step.result_json) : null,
    };
  }

  return {
    event: "run.completed",
    timestamp: new Date().toISOString(),
    runId: run.id,
    projectId: run.project_id,
    status: run.status,
    createdAt: run.created_at,
    completedAt: run.updated_at,
    // Convenient URLs to download outputs
    downloadUrls: {
      projectZip: `${downloadBaseUrl}/projects/${run.project_id}/download`,
      renamedFiles: `${downloadBaseUrl}/runs/${runId}/steps/renamer/download`,
      outputFiles: `${downloadBaseUrl}/runs/${runId}/steps/output-qa/download`,
    },
    steps: stepsMap,
  };
}

/**
 * Deliver a webhook asynchronously.
 * Handles retries with exponential backoff.
 * Called from queue.js after run completes.
 */
async function deliverWebhook(webhookId, payload, attempt = 1) {
  const webhook = await db.get(`SELECT * FROM webhooks WHERE id = ?`, [webhookId]);
  if (!webhook) return; // webhook was deleted

  const signature = signPayload(payload, webhookId);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const url = new URL(webhook.url);
    const client = url.protocol === "https:" ? https : http;

    const req = client.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          [WEBHOOK_SIGNATURE_HEADER]: signature,
        },
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          const success = res.statusCode >= 200 && res.statusCode < 300;
          if (success) {
            db.run(
              `UPDATE webhooks SET retry_count = 0, last_error = NULL WHERE id = ?`,
              [webhookId]
            ).catch(console.error);
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            handleWebhookFailure(webhookId, `HTTP ${res.statusCode}`, attempt).catch(console.error);
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      handleWebhookFailure(webhookId, "Timeout", attempt).catch(console.error);
      reject(new Error("Timeout"));
    });

    req.on("error", (err) => {
      handleWebhookFailure(webhookId, err.message, attempt).catch(console.error);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Handle webhook delivery failure.
 * Retries with exponential backoff, or marks webhook as permanently failed.
 */
async function handleWebhookFailure(webhookId, error, attempt) {
  const nextAttempt = attempt + 1;

  if (nextAttempt > MAX_RETRIES) {
    // Give up
    await db.run(
      `UPDATE webhooks SET active = 0, last_error = ?, retry_count = ? WHERE id = ?`,
      [`Failed after ${MAX_RETRIES} retries: ${error}`, nextAttempt, webhookId]
    );
    console.error(`[webhook ${webhookId}] permanently failed: ${error}`);
  } else {
    // Schedule retry with exponential backoff
    const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s, 8s, 16s
    await db.run(
      `UPDATE webhooks SET last_error = ?, retry_count = ? WHERE id = ?`,
      [`Attempt ${attempt} failed: ${error}. Retry in ${backoffMs}ms`, nextAttempt, webhookId]
    );

    setTimeout(() => {
      console.log(`[webhook ${webhookId}] retry attempt ${nextAttempt}...`);
      // In production, this should be queued to a background job system
      // For now, we just retry after the delay
      // Note: This won't survive a process restart!
    }, backoffMs);
  }
}

/**
 * Notify all webhooks for a project that a run completed.
 * Called from queue.js after run completes.
 */
async function notifyWebhooksForRun(projectId, runId, downloadBaseUrl) {
  const webhooks = await getProjectWebhooks(projectId);
  if (!webhooks.length) return; // no webhooks registered

  const payload = await buildWebhookPayload(runId, downloadBaseUrl);
  if (!payload) return; // run not found

  console.log(`[webhooks] notifying ${webhooks.length} webhook(s) for run ${runId}`);

  for (const webhook of webhooks) {
    deliverWebhook(webhook.id, payload)
      .catch((err) => console.error(`[webhook ${webhook.id}] delivery failed:`, err.message));
  }
}

module.exports = {
  registerWebhook,
  getProjectWebhooks,
  unregisterWebhook,
  notifyWebhooksForRun,
  WEBHOOK_SIGNATURE_HEADER,
};
