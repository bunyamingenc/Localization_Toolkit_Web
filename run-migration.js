const fs = require("fs");
const path = require("path");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node run-migration.js <path-to-sql-file>");
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(file), "utf8");
const db = require("better-sqlite3")("storage/loc-toolkit-api.db");

db.exec(sql);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`Applied ${path.basename(file)}. Tables:`, tables.map(t => t.name));