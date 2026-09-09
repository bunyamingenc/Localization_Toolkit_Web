const db = require('better-sqlite3')('storage/loc-toolkit-api.db');

db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  bulk_job_id TEXT,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  operation_count INTEGER NOT NULL,
  status TEXT DEFAULT 'running',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS run_metadata (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, key)
);
`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Migration complete. Tables:', tables.map(t => t.name));
