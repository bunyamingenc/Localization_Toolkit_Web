const fs = require("fs");
const path = require("path");
const db = require("../db/db");

const STEP_UPLOADS_ROOT = path.join(__dirname, "../../storage/step-uploads");
const TMP_UPLOADS_ROOT = path.join(__dirname, "../../uploads");

/**
 * Deletes projects (and their runs/steps/files) older than maxAgeHours,
 * plus any orphaned step-upload folders and stray temp upload files.
 * Called on server startup and on a recurring interval — see server.js.
 */
async function runCleanup(maxAgeHours) {
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  // ISO string comparison works correctly on both backends: SQLite stores
  // created_at as TEXT (lexicographic order = chronological order for
  // ISO8601), and Postgres's TIMESTAMP column compares an ISO string fine
  // without needing a database-specific function like SQLite's datetime().
  const cutoffIso = new Date(cutoffMs).toISOString();
  let deletedProjects = 0, deletedStepUploads = 0, deletedTmpFiles = 0;

  // 1. Expired projects — remove DB rows and their files together, so we
  // never end up with a project row pointing at a folder that no longer exists.
  const oldProjects = await db.all("SELECT * FROM projects WHERE created_at < ?", [cutoffIso]);
  for (const project of oldProjects) {
    const runs = await db.all("SELECT id FROM runs WHERE project_id = ?", [project.id]);
    for (const run of runs) {
      await db.run("DELETE FROM steps WHERE run_id = ?", [run.id]);
    }
    await db.run("DELETE FROM runs WHERE project_id = ?", [project.id]);
    await db.run("DELETE FROM projects WHERE id = ?", [project.id]);

    if (fs.existsSync(project.storage_path)) {
      fs.rmSync(project.storage_path, { recursive: true, force: true });
    }
    deletedProjects++;
  }

  // 2. Orphaned step-uploads (renamer/output-qa working copies) — these
  // aren't tracked by age anywhere else, so use the folder's own mtime.
  if (fs.existsSync(STEP_UPLOADS_ROOT)) {
    for (const entry of fs.readdirSync(STEP_UPLOADS_ROOT)) {
      const full = path.join(STEP_UPLOADS_ROOT, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(full, { recursive: true, force: true });
          deletedStepUploads++;
        }
      } catch { /* already gone — fine */ }
    }
  }

  // 3. Stray temp upload files — should be cleaned up by each route's own
  // finally block, but this is a safety net for anything that slipped
  // through (e.g. a crash mid-request).
  if (fs.existsSync(TMP_UPLOADS_ROOT)) {
    for (const entry of fs.readdirSync(TMP_UPLOADS_ROOT)) {
      const full = path.join(TMP_UPLOADS_ROOT, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(full, { force: true });
          deletedTmpFiles++;
        }
      } catch { /* already gone — fine */ }
    }
  }

  if (deletedProjects || deletedStepUploads || deletedTmpFiles) {
    console.log(`[cleanup] removed ${deletedProjects} expired project(s), ${deletedStepUploads} step-upload folder(s), ${deletedTmpFiles} stray temp file(s)`);
  }
}

module.exports = { runCleanup };
