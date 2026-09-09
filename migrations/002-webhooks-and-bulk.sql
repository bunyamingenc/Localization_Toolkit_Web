-- Migration 002: Add webhooks and bulk job support
-- Run this after migration 001 which creates projects, runs, steps

-- Webhooks: Deliver job completion notifications to external systems
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  bulk_job_id TEXT,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  -- Foreign keys (optional — depends on your database permissions)
  -- FOREIGN KEY (project_id) REFERENCES projects(id),
  -- FOREIGN KEY (bulk_job_id) REFERENCES bulk_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_bulk_job ON webhooks(bulk_job_id);

-- Bulk jobs: Track progress of multi-project processing
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  operation_count INTEGER NOT NULL,
  status TEXT DEFAULT 'running', -- 'running', 'succeeded', 'partial', 'failed'
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status ON bulk_jobs(status);

-- Add bulk_job_id to runs table (for correlation)
-- SQLite: ALTER TABLE IF EXISTS (use pragma)
-- Postgres: ALTER TABLE IF EXISTS
-- Strategy: check if column exists before adding (db-specific)

-- Run metadata: arbitrary key-value pairs per run
-- Useful for storing bulk_targets, custom parameters, etc.
CREATE TABLE IF NOT EXISTS run_metadata (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, key)
);

CREATE INDEX IF NOT EXISTS idx_run_metadata_run ON run_metadata(run_id);
