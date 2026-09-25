const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB
});

app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// Track connected agents
const connectedAgents = new Map(); // socketId -> { id, name, socketId }

// ─── REST ENDPOINTS ────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", agents: connectedAgents.size });
});

// Upload file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  console.log(`[UPLOAD] ${req.file.originalname} → ${req.file.filename}`);

  res.json({
    success: true,
    fileId: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// Get list of connected agents (for polling fallback)
app.get("/agents", (req, res) => {
  const agents = Array.from(connectedAgents.values()).map(
    ({ id, name, socketId }) => ({ id, name, socketId })
  );
  res.json({ agents });
});

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[SOCKET] Client connected: ${socket.id}`);

  // ── Agent registration ──
  socket.on("agent:register", (data) => {
    const agent = {
      id: data.id || uuidv4(),
      name: data.name || "Unknown Machine",
      socketId: socket.id,
    };
    connectedAgents.set(socket.id, agent);
    console.log(`[AGENT] Registered: ${agent.name} (${agent.id})`);

    // Broadcast updated agent list to all web clients
    io.emit("agents:update", {
      agents: Array.from(connectedAgents.values()).map(
        ({ id, name, socketId }) => ({ id, name, socketId })
      ),
    });

    // Acknowledge registration
    socket.emit("agent:registered", { agentId: agent.id });
  });

  // ── Web client requests agent list ──
  socket.on("agents:list", () => {
    socket.emit("agents:update", {
      agents: Array.from(connectedAgents.values()).map(
        ({ id, name, socketId }) => ({ id, name, socketId })
      ),
    });
  });

  // ── Print request from web client ──
  socket.on("print:request", (data) => {
    const { agentSocketId, fileId, originalName, copies = 1, color = true } = data;
    const agent = connectedAgents.get(agentSocketId);

    if (!agent) {
      socket.emit("print:error", { message: "Agent not found or disconnected." });
      return;
    }

    const filePath = path.join(UPLOADS_DIR, fileId);

    if (!fs.existsSync(filePath)) {
      socket.emit("print:error", { message: "File not found on server." });
      return;
    }

    // Read file and send to agent
    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString("base64");

    console.log(
      `[PRINT] Routing "${originalName}" to agent "${agent.name}" (${agentSocketId})`
    );

    // Notify the web client that we're sending to agent
    socket.emit("print:queued", {
      agentName: agent.name,
      originalName,
    });

    // Send to target agent
    io.to(agentSocketId).emit("print:execute", {
      fileId,
      originalName,
      fileBase64,
      copies,
      color,
      requestSocketId: socket.id, // so agent can reply to the right client
    });
  });

  // ── Agent reports print result ──
  socket.on("print:result", (data) => {
    const { requestSocketId, success, message, originalName } = data;
    console.log(
      `[RESULT] Print "${originalName}": ${success ? "SUCCESS" : "FAILED"} — ${message}`
    );

    // Relay result back to the web client that requested the print
    io.to(requestSocketId).emit(success ? "print:success" : "print:error", {
      message,
      originalName,
    });

    // Clean up the file after printing
    if (success && data.fileId) {
      const filePath = path.join(UPLOADS_DIR, data.fileId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[CLEANUP] Deleted ${data.fileId}`);
      }
    }
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    if (connectedAgents.has(socket.id)) {
      const agent = connectedAgents.get(socket.id);
      console.log(`[AGENT] Disconnected: ${agent.name}`);
      connectedAgents.delete(socket.id);

      // Broadcast updated list
      io.emit("agents:update", {
        agents: Array.from(connectedAgents.values()).map(
          ({ id, name, socketId }) => ({ id, name, socketId })
        ),
      });
    } else {
      console.log(`[SOCKET] Client disconnected: ${socket.id}`);
    }
  });
});

// ─── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🖨️  Printer-by-Scanner Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Upload: POST http://localhost:${PORT}/upload`);
  console.log(`   Agents: http://localhost:${PORT}/agents\n`);
});
