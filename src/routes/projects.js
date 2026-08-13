const express = require("express");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const fs = require("fs");
const path = require("path");
const db = require("../db/db");
const { safeExtract } = require("../lib/safeExtract");
const { persistUpload, deleteProjectStorage } = require("../lib/storage");

const router = express.Router();
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB — generous for a localization project, bounds DoS risk
const upload = multer({ dest: path.join(__dirname, "../../uploads"), limits: { fileSize: MAX_UPLOAD_BYTES } });
const STORAGE_ROOT = path.join(__dirname, "../../storage/projects");

// POST /projects — create a project by uploading a zip of the source folder
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Send a zip under field name 'file'." });

  const projectId = uuid();
  const extractPath = path.join(STORAGE_ROOT, projectId);

  try {
    await safeExtract(req.file.path, extractPath);
  } catch (err) {
    return res.status(400).json({ error: `Could not extract zip: ${err.message}` });
  } finally {
    fs.unlinkSync(req.file.path); // clean up the uploaded zip, we only keep the extracted contents
  }

  // With S3_BUCKET set, this uploads everything to S3 and removes the
  // local scratch copy, returning an "s3://..." reference to store
  // instead of a real path. Without it, this is a no-op and extractPath
  // stays exactly what it was before — unchanged local-disk behavior.
  const storagePath = await persistUpload(extractPath, projectId);

  const name = req.body.name || `Project ${projectId.slice(0, 8)}`;
  await db.run("INSERT INTO projects (id, name, storage_path) VALUES (?, ?, ?)", [projectId, name, storagePath]);

  const project = await db.get("SELECT * FROM projects WHERE id = ?", [projectId]);
  res.status(201).json(project);
});

// GET /projects/:id
router.get("/:id", async (req, res) => {
  const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

// GET /projects — list all
router.get("/", async (req, res) => {
  res.json(await db.all("SELECT * FROM projects ORDER BY created_at DESC"));
});

// GET /projects/:id/runs — run history for this project, most recent first
router.get("/:id/runs", async (req, res) => {
  const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const runs = await db.all("SELECT id, status, created_at, updated_at FROM runs WHERE project_id = ? ORDER BY created_at DESC", [project.id]);
  res.json(runs);
});

// DELETE /projects/:id
router.delete("/:id", async (req, res) => {
  const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
  if (!project) return res.status(404).json({ error: "Project not found" });

  await deleteProjectStorage(project.storage_path);
  await db.run("DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)", [req.params.id]);
  await db.run("DELETE FROM runs WHERE project_id = ?", [req.params.id]);
  await db.run("DELETE FROM projects WHERE id = ?", [req.params.id]);

  res.status(204).send();
});

module.exports = router;
