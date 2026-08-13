const path = require("path");
const fs = require("fs");

const DATABASE_URL = process.env.DATABASE_URL;
const usingPostgres = !!DATABASE_URL;

// Both backends expose the same three async methods — run/get/all — so
// every call site in the app looks identical regardless of which is
// active. SQLite's underlying driver is synchronous; wrapping its calls
// in `async function` and returning the value directly is safe (awaiting
// a non-promise value just resolves immediately) and keeps this file the
// only place that knows the difference.

let db;

if (usingPostgres) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL });

  // SQLite call sites use "?" placeholders throughout the app; Postgres
  // wants "$1, $2, ...". Translating here means no call site needs to
  // know which database is actually running.
  function toPgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async function run(sql, params = []) {
    const result = await pool.query(toPgSql(sql), params);
    return { changes: result.rowCount };
  }
  async function get(sql, params = []) {
    const result = await pool.query(toPgSql(sql), params);
    return result.rows[0];
  }
  async function all(sql, params = []) {
    const result = await pool.query(toPgSql(sql), params);
    return result.rows;
  }

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        step_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        seq BIGSERIAL
      );
    `);
  }

  // Fire the migration immediately; callers that run before it finishes
  // would only be a problem at the very first cold start, and Express
  // doesn't start accepting requests until server.js's listen() callback
  // fires, by which time this has long since resolved in practice. If you
  // hit a race on a very first boot, just restart — it's idempotent.
  migrate().catch((err) => console.error("[db] Postgres migration failed:", err.message));

  console.log("[db] DATABASE_URL set — using Postgres.");
  db = { run, get, all, usingPostgres: true };

} else {
  const Database = require("better-sqlite3");
  const DB_DIR = path.join(__dirname, "../../storage");
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  const sqlite = new Database(path.join(DB_DIR, "loc-toolkit-api.db"));
  sqlite.pragma("journal_mode = WAL");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
  `);

  async function run(sql, params = []) {
    const info = sqlite.prepare(sql).run(...params);
    return { changes: info.changes };
  }
  async function get(sql, params = []) {
    return sqlite.prepare(sql).get(...params);
  }
  async function all(sql, params = []) {
    return sqlite.prepare(sql).all(...params);
  }

  console.log("[db] No DATABASE_URL set — using local SQLite file.");
  db = { run, get, all, usingPostgres: false };
}

module.exports = db;
