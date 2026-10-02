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

// Active IPP jobs: fileId -> { printer, jobId, canceled }
// Used to cancel a specific job on demand.
const activeIppJobs = new Map();

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

/**
 * Convert a PDF buffer to an array of JPEG page buffers using ghostscript.
 * Requires: pkg install ghostscript  (on Termux)
 */
async function pdfToJpegBuffers(pdfBuf) {
  const tmpId = Date.now();
  const pdfPath  = path.join(TEMP_DIR, 'gs_in_'  + tmpId + '.pdf');
  const outGlob  = 'gs_out_' + tmpId + '_';
  const outPatt  = path.join(TEMP_DIR, outGlob + '%04d.jpg');
  fs.writeFileSync(pdfPath, pdfBuf);
  try {
    await new Promise((resolve, reject) => {
      exec(
        'gs -dNOPAUSE -dBATCH -sDEVICE=jpeg -r150 -dJPEGQ=90 "-sOutputFile=' + outPatt + '" "' + pdfPath + '"',
        { timeout: 120000 },
        (err, _, stderr) => {
          if (err) return reject(new Error(
            'Ghostscript failed. Run: pkg install ghostscript\n' + (stderr || err.message)
          ));
          resolve();
        }
      );
    });
    const pages = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(outGlob) && f.endsWith('.jpg'))
      .sort()
      .map(f => {
        const p = path.join(TEMP_DIR, f);
        const b = fs.readFileSync(p);
        try { fs.unlinkSync(p); } catch(_) {}
        return b;
      });
    if (!pages.length) throw new Error('Ghostscript produced no pages. PDF may be corrupt.');
    return pages;
  } finally {
    try { fs.unlinkSync(pdfPath); } catch(_) {}
  }
}

/**
 * Map file extension to MIME type candidates (in priority order).
 * For images we try native format first (HP printers support image/jpeg natively),
 * then fall back to PDF, then octet-stream.
 */
function getMimeCandidates(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return ['image/jpeg', 'application/pdf', 'application/octet-stream'];
  if (ext === '.png')                    return ['image/png',  'application/pdf', 'application/octet-stream'];
  if (ext === '.pdf')                    return ['application/pdf', 'application/octet-stream'];
  return ['application/octet-stream'];
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
      } catch (_) { resolve([]); }
    });
  });
}

/**
 * Submit one Print-Job to the printer.
 * Retries on server-error-busy (printer busy with previous job).
 * Returns { docFormat, jobId } on acceptance.
 */
function ippSubmitJob(printer, data, name, docFormat, copies, isColor, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 10;
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
      const code = res && res.statusCode;
      if (code === 'server-error-busy') {
        if (retriesLeft > 0) {
          log('   Printer busy — retrying in 3s (' + retriesLeft + ' left)...');
          setTimeout(() => {
            ippSubmitJob(printer, data, name, docFormat, copies, isColor, retriesLeft - 1)
              .then(resolve).catch(reject);
          }, 3000);
        } else {
          reject(new Error('Printer stayed busy after all retries. Try again in a moment.'));
        }
        return;
      }
      if (code && !code.startsWith('successful'))
        return reject(new Error(code));
      const jobAttrs = res && res['job-attributes-tag'];
      const jobId = jobAttrs && jobAttrs['job-id'];
      resolve({ docFormat, jobId });
    });
  });
}

/**
 * Poll Get-Job-Attributes until the job reaches a terminal state.
 * job-state values: 3=pending 4=pending-held 5=processing 6=processing-stopped
 *                   7=canceled 8=aborted 9=completed
 */
function waitForJobCompletion(printer, jobId, fileId) {
  const MAX_MS   = 5 * 60 * 1000; // 5 min max
  const POLL_MS  = 2500;
  const start    = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      // Check if user requested cancel
      const job = fileId && activeIppJobs.get(fileId);
      if (job && job.canceled) return reject(new Error('Print job canceled by user'));

      if (Date.now() - start > MAX_MS)
        return reject(new Error('Timed out waiting for print job to finish'));
      printer.execute('Get-Job-Attributes', {
        'operation-attributes-tag': {
          'requesting-user-name': 'PrintScan',
          'job-id': jobId,
          'requested-attributes': ['job-state', 'job-state-reasons'],
        },
      }, (err, res) => {
        if (err) return setTimeout(poll, POLL_MS); // can't query, keep polling
        const attrs   = res && res['job-attributes-tag'];
        const state   = attrs && attrs['job-state'];
        const reasons = (attrs && attrs['job-state-reasons']) || '';
        if (state === 9)  return resolve();  // completed ✅
        if (state === 7)  return reject(new Error('Print job canceled on printer'));
        if (state === 8)  return reject(new Error('Print job aborted: ' + reasons));
        log('   Job #' + jobId + ' state=' + (state || '?') + ' — waiting...');
        setTimeout(poll, POLL_MS);
      });
    }
    poll();
  });
}

/**
 * Submit a print job and wait until it is truly completed on the printer.
 * Reports success only after all pages have physically printed.
 */
async function ippPrint(printer, data, name, docFormat, copies, isColor, fileId) {
  const { jobId } = await ippSubmitJob(printer, data, name, docFormat, copies, isColor);
  if (jobId) {
    // Register job so cancel handler can target it
    if (fileId) activeIppJobs.set(fileId, { printer, jobId, canceled: false });
    log('   Job #' + jobId + ' accepted — waiting for completion...');
    try {
      await waitForJobCompletion(printer, jobId, fileId);
    } finally {
      if (fileId) activeIppJobs.delete(fileId);
    }
    log('   Job #' + jobId + ' completed successfully.');
  } else {
    log('   Job accepted (no job-id). Waiting 8s for printer...');
    await new Promise(r => setTimeout(r, 8000));
  }
  return docFormat;
}


async function printWifi(buf, name, copies, isColor, fileId) {
  if (!PRINTER_URL) throw new Error('PRINTER_URL not set in .env');

  const ext = path.extname(name).toLowerCase();
  const printer = ipp.Printer(PRINTER_URL);

  const supported = await getSupportedFormats(printer);
  log('   Printer supports: ' + (supported.join(', ') || '(unknown)'));

  // PDF but printer doesn't support application/pdf → convert pages to JPEG
  if (ext === '.pdf' && !supported.includes('application/pdf') && supported.includes('image/jpeg')) {
    log('   PDF not natively supported. Converting pages to JPEG via ghostscript...');
    const pages = await pdfToJpegBuffers(buf);
    log('   Converted ' + pages.length + ' page(s). Printing...');
    for (let i = 0; i < pages.length; i++) {
      log('   Printing page ' + (i + 1) + '/' + pages.length + '...');
      await ippPrint(printer, pages[i], name + '_p' + (i + 1), 'image/jpeg', copies, isColor, fileId);
    }
    return 'Printed ' + pages.length + ' page(s) via Wi-Fi IPP (' + (isColor ? 'Colour' : 'B&W') + ') as JPEG';
  }

  // Generic format retry loop
  const candidates = getMimeCandidates(ext);
  const toTry = supported.length > 0
    ? [...candidates.filter(f => supported.includes(f)), 'application/octet-stream']
    : candidates;
  const queue = [...new Set(toTry)];
  log('   Will try formats in order: ' + queue.join(' -> '));

  for (const fmt of queue) {
    let data = buf;
    if (fmt === 'application/pdf' && ['.jpg', '.jpeg', '.png'].includes(ext)) {
      log('   Converting image to PDF for format ' + fmt + '...');
      data = await imageToPdfBuffer(buf, ext);
    }
    log('   Trying document-format: ' + fmt);
    try {
      const usedFmt = await ippPrint(printer, data, name, fmt, copies, isColor, fileId);
      return 'Printed via Wi-Fi IPP (' + (isColor ? 'Colour' : 'B&W') + ') as ' + usedFmt;
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('document-format-not-supported') || msg.includes('client-error')) {
        log('   Format ' + fmt + ' rejected — trying next...');
        continue;
      }
      throw err;  // includes 'canceled by user' — propagates up immediately
    }
  }

  throw new Error('Printer rejected all attempted formats: ' + queue.join(', '));
}

async function printUSB(buf, name, copies) {
  // For USB: convert images to PDF, send PDFs as-is
  let data = buf;
  const ext = path.extname(name).toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    log('   Converting image to PDF for USB...');
    data = await imageToPdfBuffer(buf, ext);
  }
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

async function print(buf, name, copies, isColor, fileId) {
  return PRINTER_MODE === 'usb'
    ? await printUSB(buf, name, copies)
    : await printWifi(buf, name, copies, isColor, fileId);
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
    const message = await print(buf, originalName, numCopies, isColor, fileId);
    log('SUCCESS: ' + message);
    socket.emit('print:result', { fileId, originalName, success: true, message, requestSocketId });
  } catch (err) {
    log('FAILED : ' + err.message);
    socket.emit('print:result', { fileId, originalName, success: false, message: 'Print error: ' + err.message, requestSocketId });
  } finally {
    activeIppJobs.delete(fileId);
    if (tmpWritten && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch(_) {} }
  }
});

// ── Cancel handler ────────────────────────────────────────────────────────────
socket.on('print:cancel', (data) => {
  const { fileId } = data;
  log('\nCancel request for job: ' + fileId);

  const job = activeIppJobs.get(fileId);
  if (!job) {
    log('   No active IPP job found — may have already finished.');
    socket.emit('print:cancel:result', { fileId, success: false, message: 'No active print job found to cancel.' });
    return;
  }

  // Signal the polling loop to stop immediately
  job.canceled = true;

  if (job.jobId && job.printer) {
    log('   Sending IPP Cancel-Job #' + job.jobId + '...');
    job.printer.execute('Cancel-Job', {
      'operation-attributes-tag': {
        'requesting-user-name': 'PrintScan',
        'job-id': job.jobId,
      },
    }, (err, res) => {
      const code = res && res.statusCode;
      const ok = !err && code && code.startsWith('successful');
      log('   Cancel-Job result: ' + (ok ? 'OK' : (err ? err.message : code)));
      socket.emit('print:cancel:result', {
        fileId,
        success: true,
        message: ok
          ? 'Print job #' + job.jobId + ' canceled on printer.'
          : 'Stop signal sent. Printer may finish current page.',
      });
    });
  } else {
    socket.emit('print:cancel:result', { fileId, success: true, message: 'Print job stopped.' });
  }

  activeIppJobs.delete(fileId);
});

socket.on('disconnect', (reason) => log('Disconnected: ' + reason + '. Reconnecting...'));
socket.on('connect_error', (err) => log('Connection error: ' + err.message));
process.on('SIGINT', () => { log('Agent stopped.'); socket.disconnect(); process.exit(0); });