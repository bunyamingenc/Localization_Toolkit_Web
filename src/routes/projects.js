const express = require("express");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const fs = require("fs");
const path = require("path");
const db = require("../db/db");
const { safeExtract } = require("../lib/safeExtract");

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

  const name = req.body.name || `Project ${projectId.slice(0, 8)}`;
  db.prepare("INSERT INTO projects (id, name, storage_path) VALUES (?, ?, ?)").run(projectId, name, extractPath);

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  res.status(201).json(project);
});

// GET /projects/:id
router.get("/:id", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

// GET /projects — list all
router.get("/", (req, res) => {
  res.json(db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all());
});

// GET /projects/:id/runs — run history for this project, most recent first
router.get("/:id/runs", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const runs = db.prepare("SELECT id, status, created_at, updated_at FROM runs WHERE project_id = ? ORDER BY created_at DESC").all(project.id);
  res.json(runs);
});

// DELETE /projects/:id
router.delete("/:id", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  fs.rmSync(project.storage_path, { recursive: true, force: true });
  db.prepare("DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)").run(req.params.id);
  db.prepare("DELETE FROM runs WHERE project_id = ?").run(req.params.id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);

  res.status(204).send();
});

module.exports = router;
