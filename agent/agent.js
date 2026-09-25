/**
 * PrintScan - Print Agent (Windows)
 *
 * Run this on any Windows PC with a printer connected.
 * It connects to the cloud server (Railway) and waits for print jobs.
 *
 * Config (edit .env file in this folder):
 *   SERVER_URL    = https://your-app.up.railway.app
 *   AGENT_SECRET  = your-secret-here-change-this  (must match Railway env var)
 *   PRINTER_NAME  = (optional) exact printer name to force-use a specific printer
 *
 * To run automatically on Windows boot, use install-service.bat
 */

const { io } = require('socket.io-client');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec, execSync } = require('child_process');

// --- Load .env file ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

// --- CONFIG ---

const args = process.argv.slice(2);
const serverArgIdx = args.indexOf('--server');
const SERVER_URL =
  serverArgIdx !== -1
    ? args[serverArgIdx + 1]
    : process.env.SERVER_URL || 'http://localhost:4000';

const AGENT_SECRET = process.env.AGENT_SECRET || null;

// Optional: force a specific printer name (set PRINTER_NAME in .env)
const FORCED_PRINTER = process.env.PRINTER_NAME || null;

// Persist agent ID across restarts
const ID_FILE = path.join(__dirname, '.agent-id');
let AGENT_ID;
if (fs.existsSync(ID_FILE)) {
  AGENT_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
} else {
  AGENT_ID = uuidv4();
  fs.writeFileSync(ID_FILE, AGENT_ID);
}

const AGENT_NAME = os.hostname();
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Track active print jobs: fileId -> { printerName, docName }
// Used for cancellation
const activeJobs = new Map();

// --- HELPERS ---

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log('[' + time + '] ' + msg);
}

// Virtual/software printers - always skip these
const VIRTUAL_PRINTERS = [
  'microsoft print to pdf',
  'microsoft xps document writer',
  'onenote',
  'fax',
  'adobe pdf',
  'cutepdf',
  'foxit',
  'bullzip',
  'dopdf',
  'pdf architect',
  'nitro pdf',
  'send to onenote',
  'microsoft shared fax',
];

/**
 * Get all printers installed on this Windows PC via PowerShell.
 * Returns array of printer name strings.
 */
function getAllPrinters() {
  try {
    const result = execSync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { timeout: 10000, encoding: 'utf8' }
    );
    return result
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Find the best physical printer on this PC.
 * Priority: FORCED_PRINTER from .env -> first real non-virtual printer found.
 * Returns the printer name string, or null if none found.
 */
function getTargetPrinter() {
  if (FORCED_PRINTER) {
    log('   Using forced printer from .env: "' + FORCED_PRINTER + '"');
    return FORCED_PRINTER;
  }

  const all = getAllPrinters();
  log('   Installed printers: ' + (all.join(', ') || '(none)'));

  const physical = all.find(
    (name) => !VIRTUAL_PRINTERS.some((v) => name.toLowerCase().includes(v))
  );

  if (physical) {
    log('   Selected printer: "' + physical + '"');
  } else {
    log('   WARNING: No physical printer found! Only virtual printers installed.');
  }

  return physical || null;
}

/**
 * Cancel all queued print jobs for a given printer using PowerShell.
 * Optionally filter by document name.
 */
function cancelPrinterJobs(printerName, docNameFilter) {
  return new Promise((resolve) => {
    let ps;
    const safePrinter = printerName.replace(/'/g, "''");
    if (docNameFilter) {
      const safeDoc = docNameFilter.replace(/'/g, "''");
      ps = 'Get-PrintJob -PrinterName \'' + safePrinter + '\' | Where-Object { ' + '$' + '_.DocumentName -like \'*' + safeDoc + '*\' } | Remove-PrintJob';
    } else {
      ps = 'Get-PrintJob -PrinterName \'' + safePrinter + '\' | Remove-PrintJob';
    }

    exec(
      'powershell -NoProfile -Command "' + ps + '"',
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          log('   Cancel error: ' + (stderr || err.message));
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

/**
 * Print a file to the specified printer.
 * - PDF -> pdf-to-printer (targets exact printer, supports copies + colour mode)
 * - Word -> Microsoft Word COM automation via PowerShell
 * - Images (jpg/png) -> Convert to PDF via pdf-lib, then print
 * - Other -> PowerShell Shell print verb
 */
async function printFile(filePath, originalName, printerName, copies, isColor) {
  const ext = path.extname(originalName).toLowerCase();

  log('   File type: ' + (ext || '(no ext)') + ' | Printer: "' + printerName + '" | Copies: ' + copies + ' | Colour: ' + (isColor ? 'Yes' : 'No'));

  if (ext === '.pdf') {
    const printer = require('pdf-to-printer');
    await printer.print(filePath, {
      printer: printerName,
      copies,
      monochrome: !isColor,
    });
    return 'PDF printed on "' + printerName + '" (' + (isColor ? 'Colour' : 'B&W') + ')';
  }

  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    const { PDFDocument } = require('pdf-lib');
    const printer = require('pdf-to-printer');
    const imageBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.create();
    const image = ext === '.png'
      ? await pdfDoc.embedPng(imageBytes)
      : await pdfDoc.embedJpg(imageBytes);
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    const pdfBytes = await pdfDoc.save();
    const tempPdf = filePath + '_converted.pdf';
    fs.writeFileSync(tempPdf, pdfBytes);
    try {
      await printer.print(tempPdf, {
        printer: printerName,
        copies,
        monochrome: !isColor,
      });
    } finally {
      try { fs.unlinkSync(tempPdf); } catch (_) {}
    }
    return 'Image printed on "' + printerName + '" (' + (isColor ? 'Colour' : 'B&W') + ')';
  }

  if (['.doc', '.docx'].includes(ext)) {
    const escaped = filePath.replace(/\\/g, '\\\\');
    const printerEsc = printerName.replace(/'/g, "''");
    const ps = [
      '$' + 'word = New-Object -ComObject Word.Application',
      '$' + 'word.Visible = ' + '$' + 'false',
      '$' + 'doc = ' + '$' + 'word.Documents.Open("' + escaped + '")',
      '$' + 'word.ActivePrinter = "' + printerEsc + '"',
      'for (' + '$' + 'i = 0; ' + '$' + 'i -lt ' + copies + '; ' + '$' + 'i++) { ' + '$' + 'doc.PrintOut() }',
      'Start-Sleep -Seconds 4',
      '$' + 'doc.Close([Microsoft.Office.Interop.Word.WdSaveOptions]::wdDoNotSaveChanges)',
      '$' + 'word.Quit()',
    ].join('; ');

    await new Promise((res, rej) =>
      exec(
        'powershell -NoProfile -NonInteractive -Command "' + ps + '"',
        { timeout: 90000 },
        (err, _, stderr) => (err ? rej(new Error(stderr || err.message)) : res())
      )
    );
    return 'Word document printed on "' + printerName + '"';
  }

  if (['.bmp', '.gif', '.tiff', '.webp'].includes(ext)) {
    await new Promise((res, rej) =>
      exec('mspaint /p "' + filePath + '"', { timeout: 30000 }, (err, _, stderr) =>
        err ? rej(new Error(stderr || err.message)) : res()
      )
    );
    return 'Image printed via mspaint on "' + printerName + '"';
  }

  // Generic fallback
  const escaped = filePath.replace(/\\/g, '\\\\');
  await new Promise((res, rej) =>
    exec(
      'powershell -NoProfile -Command "Start-Process -FilePath \'' + escaped + '\' -Verb Print -Wait"',
      { timeout: 30000 },
      (err, _, stderr) => (err ? rej(new Error(stderr || err.message)) : res())
    )
  );
  return 'File sent to printer "' + printerName + '"';
}

// --- SOCKET CONNECTION ---

log('Connecting to server: ' + SERVER_URL);

const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  log('Connected to server (socket: ' + socket.id + ')');
  log('Registering as: ' + AGENT_NAME + ' (' + AGENT_ID + ')');

  // Detect printer at startup and report it
  const printerName = getTargetPrinter();

  socket.emit('agent:register', {
    id: AGENT_ID,
    name: AGENT_NAME,
    secret: AGENT_SECRET,
    printerName: printerName || '(no printer found)',
  });
});

socket.on('agent:registered', (data) => {
  log('Agent registered OK (server id: ' + data.agentId + ')');
  log('Ready to receive print jobs...');
});

socket.on('agent:rejected', (data) => {
  log('Registration rejected: ' + data.reason);
  process.exit(1);
});

// --- PRINT JOB HANDLER ---

socket.on('print:execute', async (data) => {
  const { fileId, originalName, fileBase64, copies, color = true } = data;
  const isColor = color !== false && color !== 'false';
  const numCopies = Math.min(parseInt(copies) || 1, 20);

  log('\nPrint job received: "' + originalName + '"');
  log('   Copies: ' + numCopies + ' | Colour: ' + (isColor ? 'Yes' : 'No'));

  // Detect printer NOW (handles cases where a printer was connected after startup)
  const printerName = getTargetPrinter();

  if (!printerName) {
    log('   No physical printer found! Cannot print.');
    socket.emit('print:result', {
      fileId,
      originalName,
      success: false,
      message: 'No physical printer found on the printing PC. Please connect a printer.',
      printerName: null,
    });
    return;
  }

  const tempPath = path.join(TEMP_DIR, uuidv4() + '-' + originalName);
  let tempWritten = false;

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    fs.writeFileSync(tempPath, buffer);
    tempWritten = true;

    // Track for cancellation
    activeJobs.set(fileId, { printerName, docName: originalName });

    log('   Sending to printer "' + printerName + '"...');
    const message = await printFile(tempPath, originalName, printerName, numCopies, isColor);
    log('   OK: ' + message);

    socket.emit('print:result', {
      fileId,
      originalName,
      success: true,
      message,
      printerName,
    });
  } catch (err) {
    log('   Print failed: ' + err.message);
    socket.emit('print:result', {
      fileId,
      originalName,
      success: false,
      message: 'Print error: ' + err.message,
      printerName,
    });
  } finally {
    activeJobs.delete(fileId);
    if (tempWritten && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
});

// --- CANCEL HANDLER ---

socket.on('print:cancel', async (data) => {
  const { fileId, originalName } = data;
  log('\nCancel request: "' + (originalName || fileId) + '"');

  const job = activeJobs.get(fileId);

  if (!job) {
    // Job completed or not found - still try to purge queue
    const printerName = getTargetPrinter();
    if (printerName) {
      await cancelPrinterJobs(printerName, originalName);
    }
    socket.emit('print:cancel:result', {
      fileId,
      success: true,
      message: 'Cancel attempted (job may have already completed).',
    });
    return;
  }

  const cancelled = await cancelPrinterJobs(job.printerName, job.docName);
  activeJobs.delete(fileId);

  if (cancelled) {
    log('   Print job cancelled on "' + job.printerName + '"');
    socket.emit('print:cancel:result', {
      fileId,
      success: true,
      message: 'Print job cancelled on "' + job.printerName + '"',
    });
  } else {
    log('   Cancel may have failed (job may already be printing)');
    socket.emit('print:cancel:result', {
      fileId,
      success: false,
      message: 'Could not cancel - job may have already printed.',
    });
  }
});

// --- DISCONNECT / ERRORS ---

socket.on('disconnect', (reason) => {
  log('Disconnected: ' + reason + '. Reconnecting...');
});

socket.on('connect_error', (err) => {
  log('Connection error: ' + err.message + '. Retrying...');
});

process.on('SIGINT', () => {
  log('Shutting down agent...');
  socket.disconnect();
  process.exit(0);
});
