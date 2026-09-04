const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { WebSocketServer } = require("ws");
const db = require("./database");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req,res) => {
  res.json({ ok:true, serverTime:new Date().toISOString() });
});

app.get("/api/branches", (req,res) => {
  res.json(db.prepare("SELECT * FROM branches ORDER BY id DESC").all());
});

app.post("/api/branches", (req,res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) return res.status(400).json({error:"Name and code are required"});
    const result = db.prepare("INSERT INTO branches (name, code) VALUES (?,?)").run(name, code);
    res.json(db.prepare("SELECT * FROM branches WHERE id=?").get(result.lastInsertRowid));
  } catch(e) {
    res.status(400).json({error:e.message});
  }
});

app.get("/api/announcements", (req,res) => {
  const rows = db.prepare(`
    SELECT a.*,
      GROUP_CONCAT(ab.branch_id) AS branch_ids
    FROM announcements a
    LEFT JOIN announcement_branches ab ON a.id=ab.announcement_id
    GROUP BY a.id
    ORDER BY a.id DESC
  `).all();
  res.json(rows.map(r => ({...r, branch_ids: r.branch_ids ? r.branch_ids.split(",").map(Number) : []})));
});

app.post("/api/announcements", upload.single("audio"), (req,res) => {
  try {
    if (!req.file) return res.status(400).json({error:"Audio file is required"});
    const title = req.body.title || req.file.originalname;
    const interval = Number(req.body.interval_minutes || 15);
    const start = req.body.start_time || "09:00";
    const end = req.body.end_time || "21:00";
    const branchIds = JSON.parse(req.body.branch_ids || "[]");

    const result = db.prepare(`
      INSERT INTO announcements
      (title, filename, interval_minutes, start_time, end_time, active)
      VALUES (?,?,?,?,?,0)
    `).run(title, req.file.filename, interval, start, end);

    const insert = db.prepare(
      "INSERT INTO announcement_branches (announcement_id, branch_id) VALUES (?,?)"
    );
    const tx = db.transaction(ids => ids.forEach(id => insert.run(result.lastInsertRowid, id)));
    tx(branchIds);

    broadcast({type:"schedule_changed"});
    res.json({id:Number(result.lastInsertRowid)});
  } catch(e) {
    res.status(400).json({error:e.message});
  }
});

app.post("/api/announcements/:id/activate", (req,res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE announcements SET active=0").run();
  db.prepare("UPDATE announcements SET active=1 WHERE id=?").run(id);
  broadcast({type:"schedule_changed"});
  res.json({ok:true});
});

app.post("/api/announcements/:id/stop", (req,res) => {
  db.prepare("UPDATE announcements SET active=0 WHERE id=?").run(Number(req.params.id));
  broadcast({type:"schedule_changed"});
  res.json({ok:true});
});

app.get("/api/player/:code", (req,res) => {
  const branch = db.prepare("SELECT * FROM branches WHERE code=?").get(req.params.code);
  if (!branch) return res.status(404).json({error:"Branch not found"});

  const announcement = db.prepare(`
    SELECT a.* FROM announcements a
    JOIN announcement_branches ab ON a.id=ab.announcement_id
    WHERE ab.branch_id=? AND a.active=1
    ORDER BY a.id DESC LIMIT 1
  `).get(branch.id);

  res.json({
    branch,
    announcement: announcement || null,
    serverTime: new Date().toISOString()
  });
});

const wss = new WebSocketServer({ server });

function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({type:"connected", serverTime:new Date().toISOString()}));
});

app.get("*", (req,res) => {
  res.sendFile(path.join(__dirname,"public","admin.html"));
});

server.listen(PORT, () => {
  console.log(`Vande Mart Audio server running on port ${PORT}`);
});