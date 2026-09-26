/**
 * PrintScan — Cloud Relay Server
 *
 * Runs on Railway (or any Node.js cloud host).
 * No Windows dependencies — runs on Linux.
 *
 * Environment variables (set in Railway dashboard):
 *   PORT          – auto-set by Railway
 *   AGENT_SECRET  – shared secret for agent auth (optional)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 100 * 1024 * 1024,
});

const PORT = process.env.PORT || 4000;
const AGENT_SECRET = process.env.AGENT_SECRET || null;

// --- In-memory file store -----------------------------------------------------
const fileStore = new Map();
const pendingJobs = new Map();

setInterval(() => {
  const tenMin = 10 * 60 * 1000;
  const now = Date.now();
  for (const [id, f] of fileStore) {
    if (now - f.uploadedAt > tenMin) {
      fileStore.delete(id);
      console.log("[CLEANUP] Auto-deleted stale file: " + f.originalName);
    }
  }
}, 60 * 1000);

// --- Middleware ---------------------------------------------------------------
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// --- Connected agents ---------------------------------------------------------
const agents = new Map();

// --- REST API -----------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", agents: agents.size, files: fileStore.size, uptime: Math.floor(process.uptime()) });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file" });
  const fileId = uuidv4();
  fileStore.set(fileId, {
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    uploadedAt: Date.now(),
  });
  console.log('[UPLOAD] "' + req.file.originalname + '" (' + (req.file.size / 1024).toFixed(0) + ' KB) id=' + fileId);
  res.json({ success: true, fileId, size: req.file.size });
});

app.post("/api/print-job", express.json(), async (req, res) => {
  const { fileId, originalName, copies = 1, color = true, shopId } = req.body;
  if (!fileId) return res.status(400).json({ success: false, error: "No fileId provided" });

  const stored = fileStore.get(fileId);
  if (!stored) return res.status(404).json({ success: false, error: "File not found or expired. Please re-upload." });

  if (agents.size === 0) {
    return res.status(503).json({ success: false, error: "No printer connected right now. Please tell the shop owner." });
  }

  // Find the agent by shopId (matching agent.name or agent.id)
  let agentInfo;
  if (shopId) {
    agentInfo = [...agents.values()].find(a => a.name.toLowerCase() === shopId.toLowerCase() || a.id === shopId);
  }
  
  // Fallback: if no shopId provided or not found, use the first connected printer
  if (!agentInfo) {
    agentInfo = [...agents.values()][0];
  }
  const agentId = agentInfo.id;
  const agentSocket = io.sockets.sockets.get(agentInfo.socketId);

  if (!agentSocket) {
    agents.delete(agentId);
    return res.status(503).json({ success: false, error: "Print agent disconnected. Please try again." });
  }

  const isColor = color !== false && color !== "false";
  const numCopies = Math.min(parseInt(copies) || 1, 20);
  console.log('\n Print job: "' + stored.originalName + '" x' + numCopies + ' (' + (isColor ? "Colour" : "B&W") + ') -> agent "' + agentInfo.name + '"');

  const fileBase64 = stored.buffer.toString("base64");
  fileStore.delete(fileId);

  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingJobs.delete(fileId);
      resolve({ success: false, message: "Print agent timed out (60s). Check the agent is running." });
    }, 60000);

    // Save the resolve function so the socket can call it
    pendingJobs.set(fileId, (data) => {
      clearTimeout(timeout);
      pendingJobs.delete(fileId);
      resolve(data);
    });

    agentSocket.emit("print:execute", {
      fileId,
      originalName: stored.originalName,
      fileBase64,
      copies: numCopies,
      color: isColor,
    });
  });

  if (result.success) {
    console.log("   OK: " + result.message);
    res.json({ success: true, message: result.message || "File sent to printer! " });
  } else {
    console.error("   FAIL: " + result.message);
    res.json({ success: false, error: result.message });
  }
});

app.get("/api/agents", (req, res) => {
  const list = [...agents.values()].map((a) => ({ id: a.id, name: a.name, printerName: a.printerName, connectedAt: a.connectedAt }));
  res.json({ agents: list });
});

// Cancel a print job - relay the cancel request to the agent
app.post("/api/cancel", express.json(), async (req, res) => {
  const { fileId, originalName } = req.body;
  if (!fileId) return res.status(400).json({ success: false, error: "No fileId" });

  if (agents.size === 0) {
    return res.status(503).json({ success: false, error: "No agent connected" });
  }

  const { shopId } = req.body;
  let agentInfo = shopId ? [...agents.values()].find(a => a.name.toLowerCase() === shopId.toLowerCase() || a.id === shopId) : [...agents.values()][0];
  if (!agentInfo) agentInfo = [...agents.values()][0];
  const agentSocket = io.sockets.sockets.get(agentInfo.socketId);

  if (!agentSocket) {
    return res.status(503).json({ success: false, error: "Agent disconnected" });
  }

  // Send cancel to agent and wait for result
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, message: "Cancel timed out" });
    }, 15000);

    agentSocket.emit("print:cancel", { fileId, originalName });

    io.once("print:cancel:result:" + fileId, (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

  res.json(result);
});

// --- Socket.IO ----------------------------------------------------------------
io.on("connection", (socket) => {
  console.log("[WS] New connection: " + socket.id);

  socket.on("agent:register", (data) => {
    const { id, name, secret } = data;
    if (AGENT_SECRET && secret !== AGENT_SECRET) {
      console.warn('[WS] Agent rejected - wrong secret');
      socket.emit("agent:rejected", { reason: "Invalid secret" });
      socket.disconnect(true);
      return;
    }
    const printerName = data.printerName || '(unknown)';
    agents.set(id, { id, socketId: socket.id, name: name || socket.id, printerName, connectedAt: new Date().toISOString() });
    console.log('[WS] Agent printer: ' + printerName);
    socket.data.agentId = id;
    console.log('[WS] Agent registered: "' + name + '" (' + id + ')');
    socket.emit("agent:registered", { agentId: id });
  });

  socket.on("print:result", (data) => {
    const { fileId } = data;
    console.log('[WS] Print result for "' + data.originalName + '": ' + (data.success ? "OK" : "FAIL") + " " + data.message);
    
    // Resolve the HTTP request waiting for this job
    if (pendingJobs.has(fileId)) {
      pendingJobs.get(fileId)(data);
    }
  });

  // Relay cancel request from REST to the agent
  socket.on("print:cancel:request", (data) => {
    socket.emit("print:cancel", data);
  });

  // Agent sends back cancel result - relay via event
  socket.on("print:cancel:result", (data) => {
    io.emit("print:cancel:result:" + data.fileId, data);
    console.log('[WS] Cancel result for "' + data.fileId + '": ' + (data.success ? 'OK' : 'FAIL'));
  });

  socket.on("disconnect", (reason) => {
    const agentId = socket.data.agentId;
    if (agentId) {
      const agent = agents.get(agentId);
      agents.delete(agentId);
      console.log('[WS] Agent disconnected: "' + (agent && agent.name) + '" - ' + reason);
    }
  });
});

// --- Inline HTML UI (what the phone sees) ------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <title>PrintScan - Wireless Print</title>
  <meta name="description" content="Upload a file and print it wirelessly from any device, anywhere in the world." />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#09090f;--surface2:rgba(255,255,255,0.04);--border:rgba(255,255,255,0.08);--accent:#8b5cf6;--accent2:#a78bfa;--accentdark:#6d28d9;--glow:rgba(139,92,246,0.25);--cyan:#06b6d4;--success:#10b981;--error:#ef4444;--txt:#f8fafc;--txt2:#94a3b8;--txt3:#475569}
    html,body{min-height:100%;font-family:'Outfit',system-ui,sans-serif;background:var(--bg);color:var(--txt);-webkit-font-smoothing:antialiased;overflow-x:hidden}
    .bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(139,92,246,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.04) 1px,transparent 1px);background-size:56px 56px}
    .orb1{position:fixed;top:-220px;left:-220px;width:580px;height:580px;background:radial-gradient(circle,rgba(139,92,246,.15) 0%,transparent 70%);pointer-events:none;z-index:0}
    .orb2{position:fixed;bottom:-180px;right:-120px;width:500px;height:500px;background:radial-gradient(circle,rgba(6,182,212,.1) 0%,transparent 70%);pointer-events:none;z-index:0}
    .page{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 16px 80px}
    .header{text-align:center;max-width:600px;margin-bottom:44px}
    .badge{display:inline-flex;align-items:center;gap:8px;padding:5px 16px;background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.4);border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#a78bfa;margin-bottom:20px}
    .badge .dot{width:6px;height:6px;background:#a78bfa;border-radius:50%;animation:blink 2s infinite}
    @keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}
    h1{font-size:clamp(2rem,6vw,3.4rem);font-weight:900;line-height:1.08;letter-spacing:-.03em;background:linear-gradient(135deg,#f8fafc 0%,#a78bfa 55%,#67e8f9 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:14px}
    .subtitle{font-size:1rem;color:var(--txt2);line-height:1.65;max-width:440px;margin:0 auto}
    .steps{display:flex;align-items:center;gap:10px;margin-bottom:36px;flex-wrap:wrap;justify-content:center}
    .step{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--txt3)}
    .step.active{color:var(--accent2)}.step.done{color:var(--success)}
    .step-n{width:26px;height:26px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
    .step.active .step-n{background:rgba(139,92,246,.2);border-color:var(--accent);color:var(--accent2)}
    .step.done .step-n{background:rgba(16,185,129,.2);border-color:var(--success);color:var(--success)}
    .arrow{color:var(--txt3);font-size:14px}
    .card{width:100%;max-width:620px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:24px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:36px;transition:border-color .3s}
    .card:hover{border-color:rgba(139,92,246,.3)}
    .agent-status{display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;margin-bottom:28px;font-size:.82rem;color:var(--txt3)}
    .agent-dot{width:8px;height:8px;border-radius:50%;background:var(--txt3);flex-shrink:0;transition:background .5s}
    .agent-dot.online{background:var(--success);box-shadow:0 0 8px rgba(16,185,129,.6);animation:pulse 2s infinite}
    .agent-dot.offline{background:var(--error)}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    #drop-zone{border:2px dashed var(--border);border-radius:16px;padding:56px 28px;text-align:center;cursor:pointer;transition:all .3s ease;position:relative;overflow:hidden}
    #drop-zone::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 120%,rgba(139,92,246,.12),transparent 65%);opacity:0;transition:opacity .3s}
    #drop-zone:hover,#drop-zone.over{border-color:var(--accent)}
    #drop-zone:hover::after,#drop-zone.over::after{opacity:1}
    #drop-zone.over{transform:scale(1.01);background:rgba(139,92,246,.05)}
    .upload-icon{width:76px;height:76px;margin:0 auto 20px;background:linear-gradient(135deg,var(--accentdark),var(--accent));border-radius:20px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 40px var(--glow);position:relative;z-index:1}
    .upload-icon svg{width:34px;height:34px}
    #drop-zone h3{font-size:1.15rem;font-weight:700;margin-bottom:8px;position:relative;z-index:1}
    #drop-zone p{font-size:.875rem;color:var(--txt2);margin-bottom:22px;position:relative;z-index:1}
    .chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;position:relative;z-index:1}
    .chip{padding:4px 14px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:999px;font-size:11px;font-weight:600;color:var(--txt2);letter-spacing:.04em}
    #preview{display:none;align-items:center;gap:16px;padding:18px 20px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:14px}
    .file-icon{width:54px;height:54px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0}
    .file-icon.pdf{background:rgba(239,68,68,.15)}.file-icon.word{background:rgba(37,99,235,.15)}.file-icon.img{background:rgba(16,185,129,.15)}.file-icon.other{background:rgba(139,92,246,.15)}
    .file-details{flex:1;min-width:0}
    .file-name{font-size:.95rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .file-meta{font-size:.78rem;color:var(--txt3);margin-top:4px}
    .progress-wrap{margin-top:10px}
    .progress-track{height:4px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden}
    .progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--cyan));border-radius:99px;transition:width .25s ease;width:0%}
    .copies-row{display:flex;align-items:center;gap:12px;margin:28px 0 16px}
    .copies-label{font-size:.875rem;color:var(--txt2)}
    .copies-input{width:72px;padding:8px 12px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:10px;color:var(--txt);font-family:'Outfit',sans-serif;font-size:.9rem;outline:none;transition:border-color .2s}
    .copies-input:focus{border-color:var(--accent)}
    .color-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 20px}
    .color-label{font-size:.875rem;color:var(--txt2);font-weight:500}
    .color-toggle-group{display:flex;gap:8px}
    .color-btn{padding:8px 14px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--txt2);font-family:'Outfit',sans-serif;font-size:.85rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s ease}
    .color-btn:hover{border-color:rgba(139,92,246,.5)}
    .color-btn.active{background:rgba(139,92,246,.25);border-color:var(--accent);color:#fff;box-shadow:0 0 14px rgba(139,92,246,.3)}
    .divider{display:flex;align-items:center;gap:14px;margin:28px 0 22px;color:var(--txt3);font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
    .rm-btn{width:32px;height:32px;border:none;background:rgba(239,68,68,.1);color:var(--error);border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s;flex-shrink:0}
    .rm-btn:hover{background:rgba(239,68,68,.22)}.rm-btn svg{width:16px;height:16px}
    #print-btn{width:100%;padding:18px 28px;background:linear-gradient(135deg,var(--accentdark) 0%,var(--accent) 50%,var(--cyan) 100%);background-size:200% auto;border:none;border-radius:14px;color:#fff;font-family:'Outfit',sans-serif;font-size:1.05rem;font-weight:800;letter-spacing:.01em;cursor:pointer;transition:background-position .4s,transform .15s,box-shadow .3s,opacity .2s;box-shadow:0 0 36px var(--glow);display:flex;align-items:center;justify-content:center;gap:10px}
    #print-btn:hover:not(:disabled){background-position:right center;transform:translateY(-2px);box-shadow:0 10px 50px var(--glow)}
    #print-btn:active:not(:disabled){transform:translateY(0)}
    #print-btn:disabled{opacity:.4;cursor:not-allowed}
    #print-btn svg{width:20px;height:20px}
    #status{display:none;margin-top:18px;padding:14px 18px;border-radius:12px;font-size:.9rem;font-weight:500;align-items:center;gap:10px;animation:slide-up .3s ease}
    @keyframes slide-up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    #status.success{background:rgba(16,185,129,.18);border:1px solid rgba(16,185,129,.3);color:#34d399}
    #status.error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#f87171}
    #status.loading{background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.35);color:#a78bfa}
    .spin{width:18px;height:18px;flex-shrink:0;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:rot .7s linear infinite}
    @keyframes rot{to{transform:rotate(360deg)}}
    @media(max-width:500px){.card{padding:22px 16px}#drop-zone{padding:40px 16px}h1{font-size:2.1rem}}
  </style>
</head>
<body>
<div class="bg-grid"></div><div class="orb1"></div><div class="orb2"></div>
<div class="page">
  <header class="header">
    <div class="badge"><span class="dot"></span> Wireless Print</div>
    <h1>Print From<br>Anywhere</h1>
    <p class="subtitle">Upload any file and send it to the printer — works on any internet, no WiFi sharing needed.</p>
  </header>
  <div class="steps" id="steps">
    <div class="step active" id="s1"><span class="step-n">1</span> Upload file</div>
    <span class="arrow">›</span>
    <div class="step" id="s2"><span class="step-n">2</span> Click Print</div>
    <span class="arrow">›</span>
    <div class="step" id="s3"><span class="step-n">3</span> Done!</div>
  </div>
  <div class="card">
    <div class="agent-status" id="agent-status">
      <div class="agent-dot" id="agent-dot"></div>
      <span id="agent-label">Checking printer status...</span>
    </div>
    <div id="drop-zone" role="button" tabindex="0" aria-label="Upload file">
      <div class="upload-icon" aria-hidden="true">
        <svg fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
      </div>
      <h3>Drop your file here</h3>
      <p>or tap to choose from your device</p>
      <div class="chips"><span class="chip">PDF</span><span class="chip">Word</span><span class="chip">JPG / PNG</span><span class="chip">Any File</span></div>
    </div>
    <div id="preview">
      <div class="file-icon other" id="file-icon" aria-hidden="true">??</div>
      <div class="file-details">
        <div class="file-name" id="file-name">filename.pdf</div>
        <div class="file-meta" id="file-meta">0 KB</div>
        <div class="progress-wrap" id="prog-wrap" style="display:none"><div class="progress-track"><div class="progress-fill" id="prog-fill"></div></div></div>
      </div>
      <button class="rm-btn" id="rm-btn" aria-label="Remove file">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div id="print-section" style="display:none">
      <div class="copies-row">
        <label class="copies-label" for="copies">Copies:</label>
        <input class="copies-input" type="number" id="copies" min="1" max="20" value="1" />
      </div>
      <div class="color-row">
        <label class="color-label">Colour Print:</label>
        <div class="color-toggle-group">
          <button type="button" class="color-btn active" id="btn-color-yes" aria-pressed="true">?? Yes (Colour)</button>
          <button type="button" class="color-btn" id="btn-color-no" aria-pressed="false">? No (B&amp;W)</button>
        </div>
      </div>
      <div class="divider">Ready to print</div>
      <button id="print-btn" disabled aria-label="Send to printer">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z"/></svg>
        Print
      </button>
    </div>
    <div id="status" role="alert" aria-live="polite"></div>
  </div>
</div>
<input type="file" id="file-input" style="display:none" aria-hidden="true" />
<script>
(function(){
  const dropZone=document.getElementById('drop-zone'),fileInput=document.getElementById('file-input'),
    preview=document.getElementById('preview'),fileIcon=document.getElementById('file-icon'),
    fileName=document.getElementById('file-name'),fileMeta=document.getElementById('file-meta'),
    progWrap=document.getElementById('prog-wrap'),progFill=document.getElementById('prog-fill'),
    rmBtn=document.getElementById('rm-btn'),printSec=document.getElementById('print-section'),
    printBtn=document.getElementById('print-btn'),statusEl=document.getElementById('status'),
    copiesIn=document.getElementById('copies'),agentDot=document.getElementById('agent-dot'),
    agentLabel=document.getElementById('agent-label'),
    s1=document.getElementById('s1'),s2=document.getElementById('s2'),s3=document.getElementById('s3'),
    btnColorYes=document.getElementById('btn-color-yes'),btnColorNo=document.getElementById('btn-color-no');
  let currentFile=null,fileReady=false,isColourSelected=true;
  async function checkAgentStatus(){try{const r=await fetch('/api/agents'),d=await r.json();if(d.agents&&d.agents.length>0){agentDot.className='agent-dot online';agentLabel.textContent='???  Printer ready — '+d.agents[0].name;}else{agentDot.className='agent-dot offline';agentLabel.textContent='??  No printer connected. Start the agent on the printing PC.';}}catch(_){agentDot.className='agent-dot offline';agentLabel.textContent='??  Cannot reach server.';}}
  checkAgentStatus();setInterval(checkAgentStatus,10000);
  btnColorYes.addEventListener('click',function(){isColourSelected=true;btnColorYes.classList.add('active');btnColorYes.setAttribute('aria-pressed','true');btnColorNo.classList.remove('active');btnColorNo.setAttribute('aria-pressed','false');});
  btnColorNo.addEventListener('click',function(){isColourSelected=false;btnColorNo.classList.add('active');btnColorNo.setAttribute('aria-pressed','true');btnColorYes.classList.remove('active');btnColorYes.setAttribute('aria-pressed','false');});
  function fmtBytes(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';}
  function getCategory(name){const ext=name.split('.').pop().toLowerCase();if(ext==='pdf')return'pdf';if(['doc','docx'].includes(ext))return'word';if(['jpg','jpeg','png','gif','bmp','webp','tiff','svg'].includes(ext))return'img';return'other';}
  function getEmoji(cat){return{pdf:'??',word:'??',img:'???',other:'??'}[cat];}
  function showStatus(msg,type){statusEl.className='status '+type;statusEl.style.display='flex';statusEl.innerHTML=type==='loading'?'<div class="spin"></div>'+msg:type==='success'?'? '+msg:'? '+msg;}
  function hideStatus(){statusEl.style.display='none';statusEl.innerHTML='';}
  function setStep(n){[s1,s2,s3].forEach((s,i)=>{s.className='step'+(i<n-1?' done':i===n-1?' active':'');});}
  function reset(){currentFile=null;fileReady=false;dropZone.style.display='';preview.style.display='none';printSec.style.display='none';progWrap.style.display='none';printBtn.disabled=true;hideStatus();setStep(1);}
  function handleFile(file){if(!file)return;currentFile=file;fileReady=false;printBtn.disabled=true;const cat=getCategory(file.name);fileIcon.className='file-icon '+cat;fileIcon.textContent=getEmoji(cat);fileName.textContent=file.name;fileMeta.textContent=fmtBytes(file.size);progFill.style.width='0%';progWrap.style.display='';dropZone.style.display='none';preview.style.display='flex';printSec.style.display='block';hideStatus();setStep(2);const fd=new FormData();fd.append('file',file);const xhr=new XMLHttpRequest();xhr.open('POST','/api/upload');xhr.upload.onprogress=function(e){if(e.lengthComputable)progFill.style.width=Math.round(e.loaded/e.total*100)+'%';};xhr.onload=function(){progWrap.style.display='none';if(xhr.status===200){const res=JSON.parse(xhr.responseText);window._uploadedFileId=res.fileId;fileMeta.textContent=fmtBytes(file.size)+' — Ready ?';fileReady=true;printBtn.disabled=false;}else{showStatus('Upload failed. Please try again.','error');reset();}};xhr.onerror=function(){showStatus('Network error.','error');reset();};xhr.send(fd);}
  dropZone.addEventListener('click',()=>fileInput.click());
  dropZone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')fileInput.click();});
  dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('over');});
  dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('over'));
  dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('over');const f=e.dataTransfer.files[0];if(f)handleFile(f);});
  fileInput.addEventListener('change',e=>{const f=e.target.files[0];if(f)handleFile(f);e.target.value='';});
  rmBtn.addEventListener('click',reset);
  printBtn.addEventListener('click',async function(){if(!fileReady||!window._uploadedFileId)return;printBtn.disabled=true;showStatus('Sending to printer...','loading');setStep(3);try{const urlParams = new URLSearchParams(window.location.search); const shopId = urlParams.get('shop') || '';
const reqBody = {fileId:window._uploadedFileId,originalName:currentFile.name,copies:parseInt(copiesIn.value)||1,color:isColourSelected, shopId};
const res=await fetch('/api/print-job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reqBody)});const data=await res.json();if(data.success){showStatus(data.message||'Your file has been sent to the printer!','success');s1.className='step done';s2.className='step done';s3.className='step done';setTimeout(reset,8000);}else{throw new Error(data.error||'Unknown error');}}catch(err){showStatus('Print error: '+err.message,'error');printBtn.disabled=false;setStep(2);}});
})();
</script>
</body>
</html>`;

app.get("/", (req, res) => res.send(HTML));

// --- Start --------------------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n PrintScan Cloud Server Ready on port " + PORT);
});
