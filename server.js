// VANDE MART CENTRAL AUDIO SERVER
// Full replacement for the existing GitHub file: server.js
// Includes: existing branch/announcement APIs, duplicate-title update,
// branch online/offline heartbeats, and branch-wise activation.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Supports either `module.exports = db` or `module.exports = { db }`.
const databaseModule = require('./database');
const db = databaseModule.db || databaseModule;

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype && file.mimetype.startsWith('audio/')) return callback(null, true);
    callback(new Error('Please upload an audio file.'));
  }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// --- Safe database upgrades for existing branches and announcements ---
function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

const announcementBranchColumns = tableColumns('announcement_branches');
if (!announcementBranchColumns.some((column) => column.name === 'active')) {
  db.exec(`
    ALTER TABLE announcement_branches
    ADD COLUMN active INTEGER NOT NULL DEFAULT 1
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS branch_heartbeats (
    branch_id INTEGER PRIMARY KEY,
    last_seen TEXT NOT NULL,
    computer_name TEXT,
    bot_version TEXT,
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );
  CREATE INDEX IF NOT EXISTS idx_branch_heartbeats_last_seen
    ON branch_heartbeats(last_seen);
`);

const listBranches = db.prepare(`
  SELECT id, name, code FROM branches ORDER BY name COLLATE NOCASE
`);

// --- Branches ---
app.get('/api/branches', (_req, res) => {
  res.json(listBranches.all());
});

app.post('/api/branches', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!name || !code) return res.status(400).json({ error: 'Branch name and code are required.' });

  try {
    const result = db.prepare(`INSERT INTO branches (name, code) VALUES (?, ?)`).run(name, code);
    res.status(201).json({ id: result.lastInsertRowid, name, code });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This branch code already exists.' });
    }
    throw error;
  }
});

// --- Bot heartbeat / dashboard online status ---
app.post('/api/branches/:code/heartbeat', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const branch = db.prepare(`SELECT id, name, code FROM branches WHERE UPPER(code) = ?`).get(code);
  if (!branch) return res.status(404).json({ error: 'Unknown branch code.' });

  const lastSeen = new Date().toISOString();
  const computerName = String(req.body?.computer_name || '').trim().slice(0, 120) || null;
  const botVersion = String(req.body?.bot_version || '').trim().slice(0, 40) || null;

  db.prepare(`
    INSERT INTO branch_heartbeats (branch_id, last_seen, computer_name, bot_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(branch_id) DO UPDATE SET
      last_seen = excluded.last_seen,
      computer_name = excluded.computer_name,
      bot_version = excluded.bot_version
  `).run(branch.id, lastSeen, computerName, botVersion);

  res.json({ ok: true, branch_code: branch.code, last_seen: lastSeen });
});

app.get('/api/branch-status', (_req, res) => {
  const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT b.id, b.name, b.code, h.last_seen, h.computer_name, h.bot_version
    FROM branches b
    LEFT JOIN branch_heartbeats h ON h.branch_id = b.id
    ORDER BY b.name COLLATE NOCASE
  `).all();
  res.json(rows.map((row) => ({ ...row, online: Boolean(row.last_seen && row.last_seen >= cutoff) })));
});

// --- Announcements ---
app.get('/api/announcements', (_req, res) => {
  const announcements = db.prepare(`
    SELECT id, title, filename, interval_minutes, start_time, end_time, active
    FROM announcements
    ORDER BY id DESC
  `).all().map((announcement) => ({ ...announcement, active: Boolean(announcement.active) }));
  res.json(announcements);
});

app.post('/api/announcements', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file is required.' });

  const title = String(req.body?.title || req.file.originalname).trim();
  const intervalMinutes = Number(req.body?.interval_minutes);
  const startTime = String(req.body?.start_time || '').trim();
  const endTime = String(req.body?.end_time || '').trim();
  let branchIds;
  try { branchIds = JSON.parse(req.body?.branch_ids || '[]').map(Number); } catch { branchIds = []; }
  branchIds = [...new Set(branchIds.filter((id) => Number.isInteger(id) && id > 0))];

  if (!title || !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || !startTime || !endTime || !branchIds.length) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Title, interval, times and at least one branch are required.' });
  }

  const transaction = db.transaction(() => {
    // Re-uploading the same title updates it rather than creating a duplicate.
    const existing = db.prepare(`
      SELECT id FROM announcements WHERE LOWER(title) = LOWER(?) ORDER BY id DESC LIMIT 1
    `).get(title);
    let announcementId;
    if (existing) {
      announcementId = existing.id;
      db.prepare(`
        UPDATE announcements
        SET filename = ?, interval_minutes = ?, start_time = ?, end_time = ?, active = 1
        WHERE id = ?
      `).run(req.file.filename, intervalMinutes, startTime, endTime, announcementId);
      db.prepare(`DELETE FROM announcement_branches WHERE announcement_id = ?`).run(announcementId);
    } else {
      announcementId = db.prepare(`
        INSERT INTO announcements (title, filename, interval_minutes, start_time, end_time, active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(title, req.file.filename, intervalMinutes, startTime, endTime).lastInsertRowid;
    }
    const addTarget = db.prepare(`
      INSERT INTO announcement_branches (announcement_id, branch_id, active) VALUES (?, ?, 1)
    `);
    for (const branchId of branchIds) addTarget.run(announcementId, branchId);
    return Number(announcementId);
  });

  try {
    const id = transaction();
    res.status(201).json({ ok: true, id });
  } catch (error) {
    fs.unlink(req.file.path, () => {});
    throw error;
  }
});

// Existing global controls: Stop/Activate every target of this announcement.
app.post('/api/announcements/:id/activate', (req, res) => {
  const result = db.prepare(`UPDATE announcements SET active = 1 WHERE id = ?`).run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ ok: true });
});

app.post('/api/announcements/:id/stop', (req, res) => {
  const result = db.prepare(`UPDATE announcements SET active = 0 WHERE id = ?`).run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ ok: true });
});

// New branch-wise controls for each announcement.
app.get('/api/announcements/:announcementId/branches', (req, res) => {
  const announcementId = Number(req.params.announcementId);
  if (!Number.isInteger(announcementId) || announcementId < 1) return res.status(400).json({ error: 'Invalid announcement id.' });
  const targets = db.prepare(`
    SELECT b.id, b.name, b.code, ab.active
    FROM announcement_branches ab
    JOIN branches b ON b.id = ab.branch_id
    WHERE ab.announcement_id = ?
    ORDER BY b.name COLLATE NOCASE
  `).all(announcementId).map((target) => ({ ...target, active: Boolean(target.active) }));
  res.json(targets);
});

function setAnnouncementBranchActive(req, res, active) {
  const announcementId = Number(req.params.announcementId);
  const branchId = Number(req.params.branchId);
  if (!Number.isInteger(announcementId) || !Number.isInteger(branchId) || announcementId < 1 || branchId < 1) {
    return res.status(400).json({ error: 'Invalid announcement or branch id.' });
  }
  const result = db.prepare(`
    UPDATE announcement_branches SET active = ? WHERE announcement_id = ? AND branch_id = ?
  `).run(active ? 1 : 0, announcementId, branchId);
  if (!result.changes) return res.status(404).json({ error: 'Branch is not a target of this announcement.' });
  res.json({ ok: true, announcement_id: announcementId, branch_id: branchId, active });
}

app.post('/api/announcements/:announcementId/branches/:branchId/activate', (req, res) =>
  setAnnouncementBranchActive(req, res, true)
);
app.post('/api/announcements/:announcementId/branches/:branchId/stop', (req, res) =>
  setAnnouncementBranchActive(req, res, false)
);

// This is the endpoint used by the existing Windows Option-B bot and player.
// The extra `ab.active = 1` is the branch-wise activation fix.
app.get('/api/player/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const branch = db.prepare(`SELECT id, name, code FROM branches WHERE UPPER(code) = ?`).get(code);
  if (!branch) return res.status(404).json({ error: 'Branch not found.' });

  const announcement = db.prepare(`
    SELECT a.id, a.title, a.filename, a.interval_minutes, a.start_time, a.end_time
    FROM announcements a
    JOIN announcement_branches ab ON ab.announcement_id = a.id
    WHERE ab.branch_id = ? AND a.active = 1 AND ab.active = 1
    ORDER BY a.id DESC
    LIMIT 1
  `).get(branch.id) || null;

  res.json({ serverTime: new Date().toISOString(), branch, announcement });
});

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`Vande Mart Audio server running on port ${PORT}`);
});
