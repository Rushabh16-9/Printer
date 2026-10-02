/**
 * PrintScan — Android Tablet/Phone Agent (Production)
 *
 * PRINTER_MODE=wifi  -> prints via IPP to any Wi-Fi printer
 * PRINTER_MODE=usb   -> prints via USB OTG using Termux:API
 *
 * Required .env:
 *   SERVER_URL    = https://your-app.up.railway.app
 *   AGENT_SECRET  = your-secret-here
 *   AGENT_NAME    = shop-1
 *   PRINTER_MODE  = wifi   (or usb)
 *   PRINTER_URL   = http://192.168.1.50:631/ipp/print  (wifi only)
 */

const { io }   = require('socket.io-client');
const os       = require('os');
const path     = require('path');
const fs       = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ipp      = require('ipp');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const SERVER_URL   = process.env.SERVER_URL   || 'http://localhost:4000';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_NAME   = process.env.AGENT_NAME   || os.hostname();
const PRINTER_MODE = (process.env.PRINTER_MODE || 'wifi').toLowerCase();
const PRINTER_URL  = process.env.PRINTER_URL  || null;

const ID_FILE = path.join(__dirname, '.agent-id');
let AGENT_ID;
if (fs.existsSync(ID_FILE)) {
  AGENT_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
} else {
  AGENT_ID = uuidv4();
  fs.writeFileSync(ID_FILE, AGENT_ID);
}

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, 'agent.log'), line + '\n'); } catch(_) {}
}

async function imageToPdfBuffer(imgBuf, ext) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const image = ext === '.png' ? await doc.embedPng(imgBuf) : await doc.embedJpg(imgBuf);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await doc.save());
}

async function prepareBuffer(buf, name) {
  const ext = path.extname(name).toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    log('   Converting image to PDF...');
    return { buf: await imageToPdfBuffer(buf, ext), mime: 'application/pdf' };
  }
  return { buf, mime: ext === '.pdf' ? 'application/pdf' : 'application/octet-stream' };
}

/**
 * Query the printer for supported document formats via IPP Get-Printer-Attributes.
 * Returns an array of MIME type strings, or [] on failure.
 */
function getSupportedFormats(printer) {
  return new Promise((resolve) => {
    printer.execute('Get-Printer-Attributes', {
      'operation-attributes-tag': {
        'requesting-user-name': 'PrintScan',
        'requested-attributes': ['document-format-supported'],
      },
    }, (err, res) => {
      if (err || !res) return resolve([]);
      try {
        const attrs = res['printer-attributes-tag'];
        const fmts = attrs && attrs['document-format-supported'];
        if (!fmts) return resolve([]);
        resolve(Array.isArray(fmts) ? fmts : [fmts]);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

/**
 * Choose the best document format to send.
 * Priority: application/pdf > application/postscript > application/octet-stream
 * If none of those match, use application/octet-stream as a universal fallback.
 */
function chooseBestFormat(supported, preferred) {
  if (!supported || supported.length === 0) return 'application/octet-stream';
  const priority = [preferred, 'application/pdf', 'application/postscript', 'application/octet-stream'];
  for (const fmt of priority) {
    if (fmt && supported.includes(fmt)) return fmt;
  }
  // Printer doesn't advertise octet-stream — use it anyway as last resort
  return 'application/octet-stream';
}

async function printWifi(buf, name, copies, isColor) {
  if (!PRINTER_URL) throw new Error('PRINTER_URL not set in .env');
  const { buf: data, mime: preferredMime } = await prepareBuffer(buf, name);
  const printer = ipp.Printer(PRINTER_URL);

  // Query printer for supported formats
  const supported = await getSupportedFormats(printer);
  log('   Printer supports: ' + (supported.join(', ') || '(unknown — will use octet-stream)'));

  const docFormat = chooseBestFormat(supported, preferredMime);
  log('   Using document-format: ' + docFormat);

  return new Promise((resolve, reject) => {
    printer.execute('Print-Job', {
      'operation-attributes-tag': {
        'requesting-user-name': 'PrintScan',
        'job-name': name,
        'document-format': docFormat,
      },
      'job-attributes-tag': {
        'copies': Math.min(parseInt(copies) || 1, 20),
        'print-color-mode': isColor ? 'color' : 'monochrome',
      },
      data,
    }, (err, res) => {
      if (err) return reject(new Error('IPP error: ' + err.message));
      if (res && res.statusCode && !res.statusCode.startsWith('successful'))
        return reject(new Error('Printer rejected: ' + res.statusCode + ' (format used: ' + docFormat + ')'));
      resolve('Printed via Wi-Fi IPP (' + (isColor ? 'Colour' : 'B&W') + ') as ' + docFormat);
    });
  });
}

async function printUSB(buf, name, copies) {
  const { buf: data } = await prepareBuffer(buf, name);
  const tmpPath = path.join(TEMP_DIR, 'usb_' + Date.now() + '.pdf');
  fs.writeFileSync(tmpPath, data);
  const numCopies = Math.min(parseInt(copies) || 1, 20);
  return new Promise((resolve, reject) => {
    exec('termux-usb -l', { timeout: 10000 }, (err, stdout) => {
      if (err) {
        try { fs.unlinkSync(tmpPath); } catch(_) {}
        return reject(new Error('Termux:API not installed. Install from F-Droid.'));
      }
      let devices = [];
      try { devices = JSON.parse(stdout.trim()); } catch(_) {}
      if (!devices.length) {
        try { fs.unlinkSync(tmpPath); } catch(_) {}
        return reject(new Error('No USB printer found. Connect via OTG cable.'));
      }
      const device = devices[0];
      log('   USB device: ' + device);
      const cmd = 'termux-usb -r "' + device + '" -e "sh -c \'for i in $(seq 1 ' + numCopies + '); do cat ' + tmpPath + ' > /proc/self/fd/$TERMUX_USB_FD; done\'"';
      exec(cmd, { timeout: 120000 }, (err2, _, stderr2) => {
        try { fs.unlinkSync(tmpPath); } catch(_) {}
        if (err2) return reject(new Error('USB print failed: ' + (stderr2 || err2.message)));
        resolve('Printed via USB OTG (' + numCopies + ' copies)');
      });
    });
  });
}

async function print(buf, name, copies, isColor) {
  return PRINTER_MODE === 'usb'
    ? await printUSB(buf, name, copies)
    : await printWifi(buf, name, copies, isColor);
}

log('PrintScan Agent starting...');
log('Shop : ' + AGENT_NAME + ' | Mode: ' + PRINTER_MODE.toUpperCase());
log('Cloud: ' + SERVER_URL);

const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  log('Connected! Registering as: ' + AGENT_NAME);
  socket.emit('agent:register', {
    id:          AGENT_ID,
    name:        AGENT_NAME,
    secret:      AGENT_SECRET,
    printerName: PRINTER_MODE === 'usb' ? 'USB Printer (OTG)' : (PRINTER_URL || 'Wi-Fi (not configured)'),
  });
});

socket.on('agent:registered', () => log('Ready! Waiting for print jobs...'));

socket.on('agent:rejected', (data) => {
  log('ERROR: Rejected — ' + data.reason);
  process.exit(1);
});

socket.on('print:execute', async (data) => {
  const { fileId, originalName, fileBase64, copies, color = true, requestSocketId } = data;
  const isColor = color !== false && color !== 'false';
  const numCopies = Math.min(parseInt(copies) || 1, 20);
  log('\n--- Print Job ---');
  log('File   : ' + originalName);
  log('Copies : ' + numCopies + ' | Colour: ' + (isColor ? 'Yes' : 'No (B&W)'));
  const tmpPath = path.join(TEMP_DIR, uuidv4() + '-' + originalName);
  let tmpWritten = false;
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    fs.writeFileSync(tmpPath, buf);
    tmpWritten = true;
    const message = await print(buf, originalName, numCopies, isColor);
    log('SUCCESS: ' + message);
    socket.emit('print:result', { fileId, originalName, success: true, message, requestSocketId });
  } catch (err) {
    log('FAILED : ' + err.message);
    socket.emit('print:result', { fileId, originalName, success: false, message: 'Print error: ' + err.message, requestSocketId });
  } finally {
    if (tmpWritten && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch(_) {} }
  }
});

socket.on('disconnect', (reason) => log('Disconnected: ' + reason + '. Reconnecting...'));
socket.on('connect_error', (err) => log('Connection error: ' + err.message));
process.on('SIGINT', () => { log('Agent stopped.'); socket.disconnect(); process.exit(0); });