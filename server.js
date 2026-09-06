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

/*
  Render / Local data storage

  If VANDE_MART_DATA_DIR is set, data will be stored there.
  Example:
  VANDE_MART_DATA_DIR=/var/data

  Locally, data is stored in ./data
*/
const dataDir = process.env.VANDE_MART_DATA_DIR
  ? path.resolve(process.env.VANDE_MART_DATA_DIR)
  : path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadDir = path.join(dataDir, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/*
  DEFAULT BRANCHES

  These 9 branches are automatically created when the server starts.
  INSERT OR IGNORE prevents duplicate branches.
*/
const defaultBranches = [
  { name: "ALLAGADDA", code: "ALG" },
  { name: "BETHAMCHERLA", code: "BCL" },
  { name: "KOILAKUNTLA", code: "KKL" },
  { name: "BANAGANAPALLE", code: "BPL" },
  { name: "BOMALASATRAM", code: "BST" },
  { name: "NANDYAL", code: "KSS" },
  { name: "NANDYAL", code: "TTD" },
  { name: "NANDYAL", code: "NGO" },
  { name: "MYDUKUR", code: "MYD" },
  { name: "KADAPA", code: "KDP" }
];

const insertDefaultBranch = db.prepare(`
  INSERT OR IGNORE INTO branches (name, code)
  VALUES (?, ?)
`);

for (const branch of defaultBranches) {
  insertDefaultBranch.run(branch.name, branch.code);
}

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


/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    serverTime: new Date().toISOString()
  });
});


/* =========================
   HEARTBEAT
========================= */

app.post("/api/heartbeat", (req, res) => {
  try {
    const code = String(req.body.branchCode || "")
      .trim()
      .toUpperCase();

    if (!code) {
      return res.status(400).json({
        error: "branchCode is required"
      });
    }

    const branch = db.prepare(
      "SELECT id, name, code FROM branches WHERE UPPER(code)=?"
    ).get(code);

    if (!branch) {
      return res.status(404).json({
        error: "Branch not found"
      });
    }

    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO branch_heartbeats (branch_id, last_seen)
      VALUES (?, ?)
      ON CONFLICT(branch_id)
      DO UPDATE SET last_seen=excluded.last_seen
    `).run(branch.id, now);

    res.json({
      ok: true,
      branch: branch.code,
      last_seen: now
    });

  } catch (e) {
    console.error("HEARTBEAT ERROR:", e);

    res.status(500).json({
      error: "Heartbeat failed"
    });
  }
});


/* =========================
   BRANCH STATUS
========================= */

app.get("/api/branches/status", (req, res) => {
  try {
    const now = Date.now();

    const rows = db.prepare(`
      SELECT
        b.id,
        b.name,
        b.code,
        h.last_seen
      FROM branches b
      LEFT JOIN branch_heartbeats h
        ON b.id=h.branch_id
      ORDER BY b.id DESC
    `).all();

    res.json(
      rows.map(b => {
        const lastSeenMs = b.last_seen
          ? Date.parse(b.last_seen)
          : NaN;

        const online =
          Number.isFinite(lastSeenMs) &&
          (now - lastSeenMs) <= 45000;

        return {
          ...b,
          online,
          status: online ? "Online" : "Offline"
        };
      })
    );

  } catch (e) {
    console.error("BRANCH STATUS ERROR:", e);

    res.status(500).json({
      error: "Could not get branch status"
    });
  }
});


/* =========================
   GET BRANCHES
========================= */

app.get("/api/branches", (req, res) => {
  try {
    res.json(
      db.prepare(
        "SELECT * FROM branches ORDER BY id DESC"
      ).all()
    );
  } catch (e) {
    res.status(500).json({
      error: "Could not load branches"
    });
  }
});


/* =========================
   ADD BRANCH
========================= */

app.post("/api/branches", (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const code = String(req.body.code || "")
      .trim()
      .toUpperCase();

    if (!name || !code) {
      return res.status(400).json({
        error: "Name and code are required"
      });
    }

    const result = db.prepare(`
      INSERT INTO branches (name, code)
      VALUES (?, ?)
    `).run(name, code);

    res.json(
      db.prepare(
        "SELECT * FROM branches WHERE id=?"
      ).get(result.lastInsertRowid)
    );

  } catch (e) {
    res.status(400).json({
      error: e.message
    });
  }
});


/* =========================
   GET ANNOUNCEMENTS
========================= */

app.get("/api/announcements", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        a.*,
        GROUP_CONCAT(ab.branch_id) AS branch_ids
      FROM announcements a
      LEFT JOIN announcement_branches ab
        ON a.id=ab.announcement_id
      GROUP BY a.id
      ORDER BY a.id DESC
    `).all();

    res.json(
      rows.map(r => ({
        ...r,
        branch_ids: r.branch_ids
          ? r.branch_ids.split(",").map(Number)
          : []
      }))
    );

  } catch (e) {
    res.status(500).json({
      error: "Could not load announcements"
    });
  }
});


/* =========================
   ANNOUNCEMENT BRANCHES
========================= */

app.get("/api/announcements/:id/branches", (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Invalid announcement id"
      });
    }

    const rows = db.prepare(`
      SELECT
        b.id,
        b.name,
        b.code,
        COALESCE(abs.active,0) AS active
      FROM announcement_branches ab
      JOIN branches b
        ON b.id=ab.branch_id
      LEFT JOIN announcement_branch_status abs
        ON abs.announcement_id=ab.announcement_id
       AND abs.branch_id=ab.branch_id
      WHERE ab.announcement_id=?
      ORDER BY b.name COLLATE NOCASE
    `).all(id);

    res.json(rows);

  } catch (e) {
    res.status(500).json({
      error: "Could not load announcement branches"
    });
  }
});


/* =========================
   UPLOAD ANNOUNCEMENT
========================= */

app.post(
  "/api/announcements",
  upload.single("audio"),
  (req, res) => {

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Audio file is required"
        });
      }

      const title = String(
        req.body.title || req.file.originalname
      ).trim();

      const interval = Number(
        req.body.interval_minutes || 15
      );

      const start = req.body.start_time || "09:00";
      const end = req.body.end_time || "21:00";

      let branchIds;

      try {
        branchIds = JSON.parse(
          req.body.branch_ids || "[]"
        );
      } catch (_) {
        return res.status(400).json({
          error: "Invalid branch selection"
        });
      }

      if (!title) {
        return res.status(400).json({
          error: "Announcement title is required"
        });
      }

      if (!Number.isFinite(interval) || interval < 1) {
        return res.status(400).json({
          error: "Interval must be at least 1 minute"
        });
      }

      if (!Array.isArray(branchIds) || !branchIds.length) {
        return res.status(400).json({
          error: "Select at least one branch"
        });
      }

      const cleanBranchIds = [
        ...new Set(
          branchIds
            .map(Number)
            .filter(
              id =>
                Number.isInteger(id) &&
                id > 0
            )
        )
      ];

      if (!cleanBranchIds.length) {
        return res.status(400).json({
          error: "Select at least one valid branch"
        });
      }

      const validBranches = db.prepare(`
        SELECT id
        FROM branches
        WHERE id IN (
          ${cleanBranchIds.map(() => "?").join(",")}
        )
      `).all(...cleanBranchIds);

      if (
        validBranches.length !==
        cleanBranchIds.length
      ) {
        return res.status(400).json({
          error: "One or more selected branches do not exist"
        });
      }


      /* =========================
         DUPLICATE TITLE UPDATE
      ========================= */

      const existing = db.prepare(`
        SELECT id, filename
        FROM announcements
        WHERE LOWER(TRIM(title))
          = LOWER(TRIM(?))
        ORDER BY id DESC
        LIMIT 1
      `).get(title);

      if (existing) {

        db.transaction(() => {

          db.prepare(`
            UPDATE announcements
            SET
              filename=?,
              interval_minutes=?,
              start_time=?,
              end_time=?
            WHERE id=?
          `).run(
            req.file.filename,
            interval,
            start,
            end,
            existing.id
          );


          /*
            Keep existing branch assignments
            and active states.

            Add newly selected branches.
          */

          const insertBranch = db.prepare(`
            INSERT OR IGNORE INTO
              announcement_branches
              (announcement_id, branch_id)
            VALUES (?, ?)
          `);

          const insertStatus = db.prepare(`
            INSERT OR IGNORE INTO
              announcement_branch_status
              (announcement_id, branch_id, active)
            VALUES (?, ?, 0)
          `);

          for (const branchId of cleanBranchIds) {
            insertBranch.run(
              existing.id,
              branchId
            );

            insertStatus.run(
              existing.id,
              branchId
            );
          }

        })();


        /* Delete previous audio file */

        if (
          existing.filename &&
          existing.filename !== req.file.filename
        ) {

          const oldPath = path.join(
            uploadDir,
            existing.filename
          );

          if (fs.existsSync(oldPath)) {
            try {
              fs.unlinkSync(oldPath);
            } catch (_) {}
          }
        }

        broadcast({
          type: "schedule_changed"
        });

        return res.json({
          id: Number(existing.id),
          updated: true,
          message:
            "Existing announcement updated. Existing branch assignments preserved."
        });
      }


      /* =========================
         NEW ANNOUNCEMENT
      ========================= */

      const result = db.prepare(`
        INSERT INTO announcements
        (
          title,
          filename,
          interval_minutes,
          start_time,
          end_time,
          active
        )
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(
        title,
        req.file.filename,
        interval,
        start,
        end
      );

      const announcementId =
        Number(result.lastInsertRowid);


      db.transaction(() => {

        const insertBranch = db.prepare(`
          INSERT INTO announcement_branches
          (announcement_id, branch_id)
          VALUES (?, ?)
        `);

        const insertStatus = db.prepare(`
          INSERT INTO announcement_branch_status
          (announcement_id, branch_id, active)
          VALUES (?, ?, 0)
        `);

        for (const branchId of cleanBranchIds) {

          insertBranch.run(
            announcementId,
            branchId
          );

          insertStatus.run(
            announcementId,
            branchId
          );
        }

      })();


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        id: announcementId,
        updated: false
      });

    } catch (e) {

      console.error("UPLOAD ERROR:", e);

      if (
        req.file &&
        req.file.filename
      ) {

        const failedPath = path.join(
          uploadDir,
          req.file.filename
        );

        if (fs.existsSync(failedPath)) {
          try {
            fs.unlinkSync(failedPath);
          } catch (_) {}
        }
      }

      res.status(400).json({
        error: e.message
      });
    }
  }
);


/* =========================
   GLOBAL ACTIVATE
========================= */

app.post(
  "/api/announcements/:id/activate",
  (req, res) => {

    try {

      const id = Number(req.params.id);

      const announcement = db.prepare(
        "SELECT id FROM announcements WHERE id=?"
      ).get(id);

      if (!announcement) {
        return res.status(404).json({
          error: "Announcement not found"
        });
      }

      const branchRows = db.prepare(
        "SELECT branch_id FROM announcement_branches WHERE announcement_id=?"
      ).all(id);

      if (!branchRows.length) {
        return res.status(400).json({
          error: "Announcement has no branch targets"
        });
      }

      db.transaction(() => {

        for (const row of branchRows) {

          /* Stop other announcements for this branch */

          db.prepare(`
            UPDATE announcement_branch_status
            SET active=0
            WHERE branch_id=?
          `).run(row.branch_id);


          /* Activate selected announcement */

          db.prepare(`
            INSERT INTO announcement_branch_status
            (
              announcement_id,
              branch_id,
              active
            )
            VALUES (?, ?, 1)
            ON CONFLICT(
              announcement_id,
              branch_id
            )
            DO UPDATE SET active=1
          `).run(
            id,
            row.branch_id
          );
        }


        /* Update global active flags */

        db.prepare(
          "UPDATE announcements SET active=0"
        ).run();

        db.prepare(`
          UPDATE announcements
          SET active=1
          WHERE id IN (
            SELECT DISTINCT announcement_id
            FROM announcement_branch_status
            WHERE active=1
          )
        `).run();

      })();


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        ok: true,
        announcement_id: id
      });

    } catch (e) {

      console.error(
        "GLOBAL ACTIVATE ERROR:",
        e
      );

      res.status(500).json({
        error: "Could not activate announcement"
      });
    }
  }
);


/* =========================
   GLOBAL STOP
========================= */

app.post(
  "/api/announcements/:id/stop",
  (req, res) => {

    try {

      const id = Number(req.params.id);

      db.transaction(() => {

        db.prepare(`
          UPDATE announcement_branch_status
          SET active=0
          WHERE announcement_id=?
        `).run(id);


        db.prepare(`
          UPDATE announcements
          SET active=CASE
            WHEN EXISTS (
              SELECT 1
              FROM announcement_branch_status abs
              WHERE
                abs.announcement_id=announcements.id
                AND abs.active=1
            )
            THEN 1
            ELSE 0
          END
        `).run();

      })();


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        ok: true
      });

    } catch (e) {

      res.status(500).json({
        error: "Could not stop announcement"
      });
    }
  }
);


/* =========================
   BRANCH-SPECIFIC ACTIVATE
========================= */

app.post(
  "/api/announcements/:announcementId/branches/:branchId/activate",
  (req, res) => {

    try {

      const announcementId =
        Number(req.params.announcementId);

      const branchId =
        Number(req.params.branchId);


      const target = db.prepare(`
        SELECT
          announcement_id,
          branch_id
        FROM announcement_branches
        WHERE
          announcement_id=?
          AND branch_id=?
      `).get(
        announcementId,
        branchId
      );


      if (!target) {
        return res.status(404).json({
          error:
            "This announcement is not assigned to this branch"
        });
      }


      db.transaction(() => {

        /* Stop all announcements for this branch */

        db.prepare(`
          UPDATE announcement_branch_status
          SET active=0
          WHERE branch_id=?
        `).run(branchId);


        /* Activate selected announcement */

        db.prepare(`
          INSERT INTO announcement_branch_status
          (
            announcement_id,
            branch_id,
            active
          )
          VALUES (?, ?, 1)
          ON CONFLICT(
            announcement_id,
            branch_id
          )
          DO UPDATE SET active=1
        `).run(
          announcementId,
          branchId
        );


        /* Update announcement active flags */

        db.prepare(`
          UPDATE announcements
          SET active=CASE
            WHEN EXISTS (
              SELECT 1
              FROM announcement_branch_status abs
              WHERE
                abs.announcement_id=announcements.id
                AND abs.active=1
            )
            THEN 1
            ELSE 0
          END
        `).run();

      })();


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        ok: true,
        announcement_id: announcementId,
        branch_id: branchId,
        active: true
      });

    } catch (e) {

      console.error(
        "BRANCH ACTIVATE ERROR:",
        e
      );

      res.status(500).json({
        error:
          "Could not activate announcement for branch"
      });
    }
  }
);


/* =========================
   BRANCH-SPECIFIC STOP
========================= */

app.post(
  "/api/announcements/:announcementId/branches/:branchId/stop",
  (req, res) => {

    try {

      const announcementId =
        Number(req.params.announcementId);

      const branchId =
        Number(req.params.branchId);


      const target = db.prepare(`
        SELECT
          announcement_id,
          branch_id
        FROM announcement_branches
        WHERE
          announcement_id=?
          AND branch_id=?
      `).get(
        announcementId,
        branchId
      );


      if (!target) {
        return res.status(404).json({
          error:
            "This announcement is not assigned to this branch"
        });
      }


      db.transaction(() => {

        db.prepare(`
          INSERT INTO announcement_branch_status
          (
            announcement_id,
            branch_id,
            active
          )
          VALUES (?, ?, 0)
          ON CONFLICT(
            announcement_id,
            branch_id
          )
          DO UPDATE SET active=0
        `).run(
          announcementId,
          branchId
        );


        db.prepare(`
          UPDATE announcements
          SET active=CASE
            WHEN EXISTS (
              SELECT 1
              FROM announcement_branch_status abs
              WHERE
                abs.announcement_id=announcements.id
                AND abs.active=1
            )
            THEN 1
            ELSE 0
          END
        `).run();

      })();


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        ok: true,
        announcement_id: announcementId,
        branch_id: branchId,
        active: false
      });

    } catch (e) {

      console.error(
        "BRANCH STOP ERROR:",
        e
      );

      res.status(500).json({
        error:
          "Could not stop announcement for branch"
      });
    }
  }
);


/* =========================
   DELETE ANNOUNCEMENT
========================= */

app.delete(
  "/api/announcements/:id",
  (req, res) => {

    const id = Number(req.params.id);

    try {

      const item = db.prepare(
        "SELECT filename FROM announcements WHERE id=?"
      ).get(id);

      if (!item) {
        return res.status(404).json({
          error: "Announcement not found"
        });
      }


      db.transaction(() => {

        db.prepare(`
          DELETE FROM announcement_branch_status
          WHERE announcement_id=?
        `).run(id);

        db.prepare(`
          DELETE FROM announcement_branches
          WHERE announcement_id=?
        `).run(id);

        db.prepare(`
          DELETE FROM announcements
          WHERE id=?
        `).run(id);

      })();


      /* Delete audio file */

      if (item.filename) {

        const filePath = path.join(
          uploadDir,
          item.filename
        );

        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (_) {}
        }
      }


      broadcast({
        type: "schedule_changed"
      });

      res.json({
        ok: true
      });

    } catch (e) {

      console.error(
        "DELETE ANNOUNCEMENT ERROR:",
        e
      );

      res.status(400).json({
        error: e.message
      });
    }
  }
);


/* =========================
   BRANCH BOT PLAYER API
========================= */

app.get(
  "/api/player/:code",
  (req, res) => {

    try {

      const code = String(
        req.params.code || ""
      )
        .trim()
        .toUpperCase();


      const branch = db.prepare(
        "SELECT * FROM branches WHERE UPPER(code)=?"
      ).get(code);


      if (!branch) {
        return res.status(404).json({
          error: "Branch not found"
        });
      }


      const announcement = db.prepare(`
        SELECT a.*
        FROM announcements a
        JOIN announcement_branches ab
          ON a.id=ab.announcement_id
        JOIN announcement_branch_status abs
          ON abs.announcement_id=ab.announcement_id
         AND abs.branch_id=ab.branch_id
        WHERE
          ab.branch_id=?
          AND abs.active=1
        ORDER BY a.id DESC
        LIMIT 1
      `).get(branch.id);


      res.json({
        branch,
        announcement: announcement || null,
        serverTime: new Date().toISOString()
      });

    } catch (e) {

      console.error(
        "PLAYER API ERROR:",
        e
      );

      res.status(500).json({
        error: "Could not load player data"
      });
    }
  }
);


/* =========================
   WEBSOCKET
========================= */

const wss = new WebSocketServer({
  server
});


function broadcast(message) {

  const data = JSON.stringify(message);

  wss.clients.forEach(client => {

    if (client.readyState === 1) {
      client.send(data);
    }

  });
}


wss.on("connection", ws => {

  ws.send(
    JSON.stringify({
      type: "connected",
      serverTime:
        new Date().toISOString()
    })
  );

});


/* =========================
   ADMIN PAGE
========================= */

app.get("*", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin.html"
    )
  );

});


/* =========================
   START SERVER
========================= */

server.listen(PORT, () => {

  console.log(
    `Vande Mart Audio server running on port ${PORT}`
  );

  console.log(
    "Default branches loaded:",
    defaultBranches.map(b => `${b.name} - ${b.code}`).join(", ")
  );

});
