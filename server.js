require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const pool = require("./db");
const authRoutes = require("./routes/authRoutes");
const { authenticateToken } = require("./middleware/auth");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("Set a JWT_SECRET of at least 32 characters in .env");
}

const app = express();
const server = http.createServer(app);

const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5000";

const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e6
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://cdn.socket.io"],
      "connect-src": ["'self'", "ws:", "wss:"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"]
    }
  }
}));

app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use("/api/auth", authRoutes);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, created_at FROM users WHERE id = $1",
      [req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user: result.rows[0] });
  } catch {
    res.status(500).json({ message: "Unable to load your profile." });
  }
});

// Serve the frontend from the same server.
const publicDir = path.join(__dirname, "../Frontend");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- Secure file upload ----------
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const maxFileSize = Math.max(
  1,
  Number.parseInt(process.env.MAX_FILE_SIZE_MB || "10", 10)
) * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, uploadDir),
  filename: (req, file, callback) => {
    const ext = path.extname(file.originalname).slice(0, 15);
    callback(null, `${crypto.randomUUID()}${ext}`);
  }
});

const uploader = multer({
  storage,
  limits: { fileSize: maxFileSize, files: 5 }
});

app.post(
  "/api/files/:roomId",
  authenticateToken,
  uploader.array("files", 5),
  async (req, res) => {
    const roomId = String(req.params.roomId || "");

    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(roomId)) {
      for (const file of req.files || []) fs.unlink(file.path, () => {});
      return res.status(400).json({ message: "Invalid room code." });
    }

    if (!io.sockets.adapter.rooms.has(roomId)) {
      for (const file of req.files || []) fs.unlink(file.path, () => {});
      return res.status(404).json({ message: "Room not found." });
    }

    const saved = [];

    try {
      for (const file of req.files || []) {
        const result = await pool.query(
          `INSERT INTO shared_files
            (room_id, user_id, original_name, stored_name, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, room_id, original_name, size_bytes, created_at`,
          [
            roomId,
            req.user.id,
            path.basename(file.originalname).slice(0, 255),
            file.filename,
            file.mimetype,
            file.size
          ]
        );

        saved.push(result.rows[0]);
      }

      io.to(roomId).emit("file:shared", {
        name: saved.length === 1 ? saved[0].original_name : `${saved.length} files`,
        files: saved
      });

      res.status(201).json({ files: saved });
    } catch (error) {
      for (const file of req.files || []) fs.unlink(file.path, () => {});
      console.error("File upload error:", error.message);
      res.status(500).json({ message: "Unable to save uploaded files." });
    }
  }
);

app.get("/api/files/:roomId", authenticateToken, async (req, res) => {
  try {
    const roomId = String(req.params.roomId || "");

    const result = await pool.query(
      `SELECT id, room_id, original_name, size_bytes, created_at
       FROM shared_files
       WHERE room_id = $1
       ORDER BY created_at DESC`,
      [roomId]
    );

    res.json({ files: result.rows });
  } catch {
    res.status(500).json({ message: "Unable to list shared files." });
  }
});

app.get("/api/files/download/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT original_name, stored_name FROM shared_files WHERE id = $1",
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "File not found." });
    }

    const file = result.rows[0];
    const filePath = path.join(uploadDir, file.stored_name);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File is missing from storage." });
    }

    res.download(filePath, file.original_name);
  } catch {
    res.status(500).json({ message: "Unable to download the file." });
  }
});

// ---------- Socket.IO authentication ----------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) return next(new Error("Authentication required"));

    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid or expired session"));
  }
});

const rooms = new Map();

function validRoomId(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function getRoomParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];

  return [...room.values()].map((user) => ({
    socketId: user.socketId,
    name: user.name,
    email: user.email
  }));
}

function broadcastParticipants(roomId) {
  io.to(roomId).emit("room:participants", {
    roomId,
    participants: getRoomParticipants(roomId)
  });
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) rooms.delete(roomId);
  }

  socket.leave(roomId);
  socket.to(roomId).emit("room:peer-left", {
    socketId: socket.id,
    participants: getRoomParticipants(roomId)
  });

  broadcastParticipants(roomId);
  socket.data.roomId = null;
}

io.on("connection", (socket) => {
  const user = socket.user;

  socket.on("room:join", (data = {}) => {
    const roomId = data.roomId;

    if (!validRoomId(roomId)) {
      return socket.emit("room:error", { message: "Invalid room code." });
    }

    if (socket.data.roomId === roomId) {
      return socket.emit("room:joined", {
        roomId,
        participants: getRoomParticipants(roomId)
      });
    }

    leaveCurrentRoom(socket);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());

    const room = rooms.get(roomId);

    if (room.size >= 12) {
      return socket.emit("room:error", {
        message: "This room is full. Try another room."
      });
    }

    // Tell the joining client about existing peers so WebRTC
    // negotiation can be initiated by the frontend.
    const existingPeers = getRoomParticipants(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;

    room.set(socket.id, {
      socketId: socket.id,
      id: user.id,
      name: user.name,
      email: user.email
    });

    socket.emit("room:joined", {
      roomId,
      participants: getRoomParticipants(roomId),
      existingPeers
    });

    socket.to(roomId).emit("room:peer-joined", {
      socketId: socket.id,
      name: user.name,
      email: user.email,
      participants: getRoomParticipants(roomId)
    });

    broadcastParticipants(roomId);
  });

  socket.on("room:leave", () => leaveCurrentRoom(socket));

  // Broadcast messages to the other members, not back to the sender.
  socket.on("chat:message", (data = {}) => {
    const roomId = socket.data.roomId;
    const message = typeof data.text === "string" ? data.text.trim() : "";

    if (!roomId || !message || message.length > 2000) return;

    socket.to(roomId).emit("chat:message", {
      name: user.name,
      email: user.email,
      text: message,
      timestamp: new Date().toISOString()
    });
  });

  socket.on("whiteboard:draw", (data = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || data.roomId !== roomId) return;

    const validPoint = (p) =>
      p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
      Math.abs(p.x) < 10000 && Math.abs(p.y) < 10000;

    if (!validPoint(data.from) || !validPoint(data.to)) return;

    const color = typeof data.color === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : "#6955e8";

    const size = Number.isFinite(data.size)
      ? Math.max(1, Math.min(30, data.size))
      : 3;

    socket.to(roomId).emit("whiteboard:draw", {
      from: data.from,
      to: data.to,
      color,
      size
    });
  });

  socket.on("whiteboard:clear", (data = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || data.roomId !== roomId) return;
    socket.to(roomId).emit("whiteboard:clear");
  });

  // Relay WebRTC offers, answers, and ICE candidates to a peer.
  socket.on("rtc:signal", (data = {}) => {
    const roomId = socket.data.roomId;
    const targetId = data.to;
    const target = io.sockets.sockets.get(targetId);

    if (!roomId || !target || target.data.roomId !== roomId) return;

    target.emit("rtc:signal", {
      from: socket.id,
      signal: data.signal
    });
  });

  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

// ---------- Error handling ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `Upload error: ${err.message}` });
  }

  console.error("Server error:", err.message);
  res.status(500).json({ message: "An unexpected server error occurred." });
});

const PORT = Number(process.env.PORT || 5000);

async function startServer() {
  await pool.query("SELECT 1");

  server.listen(PORT, () => {
    console.log(`ConnectSphere running at http://localhost:${PORT}`);
    console.log("PostgreSQL connection successful.");
  });
}

startServer().catch((error) => {
  console.error("Unable to start server:", error.message);
  process.exit(1);
});

async function shutdown() {
  server.close();
  io.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
