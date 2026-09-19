const express = require("express");
const path = require("path");
const projectRoutes = require("./routes/projects");
const runRoutes = require("./routes/runs");
const bulkRoutes = require("./routes/bulk");
const webhookRoutes = require("./routes/webhooks");
const { apiKeyAuth } = require("./middleware/apiKeyAuth");
const { runCleanup } = require("./lib/cleanup");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public"))); // public shell — no key needed
app.use(apiKeyAuth); // gate everything below

app.use("/projects", projectRoutes);
app.use("/", runRoutes); // mounts /projects/:projectId/runs and /runs/:id
app.use("/api/bulk", bulkRoutes);
app.use("/api", webhookRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Loc Toolkit API listening on http://localhost:${PORT}`);
});

// Expired projects and stray upload folders are cleaned up automatically —
// once on startup, then on a recurring interval. Configurable via env vars
// so a deployment can tune retention without a code change.
const CLEANUP_MAX_AGE_HOURS = Number(process.env.CLEANUP_MAX_AGE_HOURS || 24);
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 60);

runCleanup(CLEANUP_MAX_AGE_HOURS).catch((err) => console.error("[cleanup] failed:", err.message));
setInterval(() => {
  runCleanup(CLEANUP_MAX_AGE_HOURS).catch((err) => console.error("[cleanup] failed:", err.message));
}, CLEANUP_INTERVAL_MINUTES * 60 * 1000);