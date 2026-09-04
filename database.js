const Database = require("better-sqlite3");
const db = new Database("vande_mart_audio.db");

db.pragma("journal_mode = WAL");

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
  PRIMARY KEY (announcement_id, branch_id)
);
`);

module.exports = db;