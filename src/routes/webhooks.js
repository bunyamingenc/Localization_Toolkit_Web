/**
 * Webhooks Management Routes
 * 
 * Register, list, and manage webhooks for a project.
 * Webhooks are called when runs complete, with signed payloads.
 */

const express = require("express");
const {
  registerWebhook,
  getProjectWebhooks,
  unregisterWebhook,
} = require("../lib/webhooks");

const router = express.Router();

/**
 * POST /projects/:projectId/webhooks
 * 
 * Register a new webhook for a project.
 * 
 * Body:
 * {
 *   "url": "https://my-system.com/loc-toolkit-callback"
 * }
 * 
 * Returns:
 * {
 *   "id": "webhook-uuid",
 *   "projectId": "project-uuid",
 *   "url": "https://...",
 *   "createdAt": "2026-08-14T...",
 *   "active": true,
 *   "_links": {
 *     "test": "POST /webhooks/{id}/test",
 *     "delete": "DELETE /webhooks/{id}"
 *   }
 * }
 */
router.post("/projects/:projectId/webhooks", async (req, res) => {
  const { projectId } = req.params;
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: "webhook url is required",
      example: { url: "https://my-tms.com/callbacks/loc-toolkit" },
    });
  }

  try {
    // Validate URL format
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    const webhook = await registerWebhook(projectId, url);
    res.status(201).json({
      ...webhook,
      _links: {
        test: { method: "POST", href: `/webhooks/${webhook.id}/test` },
        delete: { method: "DELETE", href: `/webhooks/${webhook.id}` },
        list: { method: "GET", href: `/projects/${projectId}/webhooks` },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /projects/:projectId/webhooks
 * 
 * List all webhooks registered for a project.
 */
router.get("/projects/:projectId/webhooks", async (req, res) => {
  try {
    const webhooks = await getProjectWebhooks(req.params.projectId);
    res.json(
      webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        active: w.active,
        createdAt: w.created_at,
        retryCount: w.retry_count,
        lastError: w.last_error,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /webhooks/:webhookId
 * 
 * Unregister a webhook. It will no longer receive notifications.
 */
router.delete("/webhooks/:webhookId", async (req, res) => {
  try {
    await unregisterWebhook(req.params.webhookId);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/:webhookId/test
 * 
 * Send a test webhook payload to verify the URL is reachable
 * and the external system is ready to receive notifications.
 */
router.post("/webhooks/:webhookId/test", async (req, res) => {
  const { webhookId } = req.params;

  try {
    // TODO: implement test payload delivery
    // For now, return a template of what a real payload looks like
    res.json({
      message: "Test delivery not yet implemented",
      examplePayload: {
        event: "run.completed",
        timestamp: new Date().toISOString(),
        runId: "run-uuid",
        projectId: "project-uuid",
        status: "succeeded",
        completedAt: new Date().toISOString(),
        downloadUrls: {
          projectZip: "https://api.example.com/projects/uuid/download",
          renamedFiles: "https://api.example.com/runs/uuid/steps/renamer/download",
          outputFiles: "https://api.example.com/runs/uuid/steps/output-qa/download",
        },
        steps: {
          cat_import: {
            status: "done",
            result: { source_locale: "en", locales: ["de", "fr"] },
          },
          renamer: { status: "done", result: {} },
          output_encoding_qa: { status: "done", result: {} },
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
