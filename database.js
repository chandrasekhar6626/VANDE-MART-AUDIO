const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

/*
  Database storage

  If VANDE_MART_DATA_DIR is set,
  database will be stored there.

  Example:
  VANDE_MART_DATA_DIR=/var/data

  Locally:
  ./data/vande_mart_audio.db
*/

const dataDir = process.env.VANDE_MART_DATA_DIR
  ? path.resolve(process.env.VANDE_MART_DATA_DIR)
  : path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(
  dataDir,
  "vande_mart_audio.db"
);

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");


/* =========================
   DATABASE TABLES
========================= */

db.exec(`

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  interval_minutes INTEGER DEFAULT 15,
  start_time TEXT DEFAULT '09:00',
  end_time TEXT DEFAULT '21:00',
  active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS announcement_branches (
  announcement_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,

  PRIMARY KEY (
    announcement_id,
    branch_id
  ),

  FOREIGN KEY (announcement_id)
    REFERENCES announcements(id)
    ON DELETE CASCADE,

  FOREIGN KEY (branch_id)
    REFERENCES branches(id)
    ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS branch_heartbeats (
  branch_id INTEGER PRIMARY KEY,
  last_seen TEXT NOT NULL,

  FOREIGN KEY (branch_id)
    REFERENCES branches(id)
    ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS announcement_branch_status (
  announcement_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (
    announcement_id,
    branch_id
  ),

  FOREIGN KEY (announcement_id)
    REFERENCES announcements(id)
    ON DELETE CASCADE,

  FOREIGN KEY (branch_id)
    REFERENCES branches(id)
    ON DELETE CASCADE
);

`);


/*
  Make sure every existing
  announcement/branch mapping
  has a status record.
*/

db.exec(`
  INSERT OR IGNORE INTO announcement_branch_status
    (
      announcement_id,
      branch_id,
      active
    )
  SELECT
    announcement_id,
    branch_id,
    0
  FROM announcement_branches;
`);


module.exports = db;
