const { io } = require('socket.io-client');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// --- Load .env ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// --- CONFIG ---
const SERVER_URL   = process.env.SERVER_URL   || 'http://localhost:4000';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_NAME   = process.env.AGENT_NAME   || os.hostname();

const ID_FILE = path.join(__dirname, '.agent-id');
let AGENT_ID;
if (fs.existsSync(ID_FILE)) {
  AGENT_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
} else {
  AGENT_ID = uuidv4();
  fs.writeFileSync(ID_FILE, AGENT_ID);
}

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

log('Starting Tablet/Phone Agent...');
log('Connecting to: ' + SERVER_URL);

const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 3000,
});

socket.on('connect', () => {
  log('Connected to cloud! Registering as: ' + AGENT_NAME);
  socket.emit('agent:register', {
    id: AGENT_ID,
    name: AGENT_NAME,
    secret: AGENT_SECRET,
    printerName: 'Mobile Phone Test'
  });
});

socket.on('agent:registered', () => {
  log('Registered successfully! Ready to receive test print jobs...');
});

socket.on('print:execute', async (data) => {
  const { fileId, originalName, copies } = data;
  log('\n>>> RECEIVED PRINT JOB: "' + originalName + '" | Copies: ' + copies);
  log('    (Since this is a test on a phone, we are not actually printing it to a physical printer)');
  
  setTimeout(() => {
    log('    Sending success message back to server...');
    socket.emit('print:result', { 
      fileId, originalName, success: true, 
      message: 'Test printed successfully on mobile phone!' 
    });
  }, 2000);
});

socket.on('disconnect', () => log('Disconnected from server.'));