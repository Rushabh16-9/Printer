# PrintScan — Cloud-Powered Wireless Printing

Scan a QR code from **anywhere in the world** → upload a file → print!  
No same-WiFi requirement. No laptop to manually run.

---

## Architecture

```
Phone (any internet, anywhere)
    ↓
Railway  ←── Cloud Node.js server (always-on, free tier)
    ↓  Socket.IO over internet
Windows Service on printing PC  →  Printer
```

| Component | Runs on | Who manages it |
|-----------|---------|----------------|
| **Web UI + API** | Railway (cloud) | Automatic, always-on |
| **Print Agent** | Printing PC | Silent Windows Service — auto-starts on boot |

---

## One-time Setup

### Step 1 — Deploy the Server to Railway

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
2. Connect your GitHub repo (push this project first, or use **Deploy from local**)
3. Select the **`server/`** folder as the root
4. Railway auto-detects Node.js and runs `node server.js`
5. In **Variables** tab, add:
   - `AGENT_SECRET` = any long random string (e.g. `my-super-secret-123`)
6. Copy your Railway URL: `https://xxxx.up.railway.app`

> **That's your permanent public URL** — no laptop needed to keep it running.

### Step 2 — Configure the Print Agent

On the PC that has the printer:

```bat
cd agent
npm install
copy .env.example .env
```

Edit `.env`:
```
SERVER_URL=https://xxxx.up.railway.app
AGENT_SECRET=my-super-secret-123
```
(Use the same values as in Railway Variables)

### Step 3 — Install as Windows Service (auto-start on boot)

Run **as Administrator**:
```bat
cd agent
install-service.bat
```

That's it. The agent now:
- Starts silently when Windows boots
- Connects to the Railway cloud server
- Waits for print jobs
- User never needs to touch it again

### Step 4 — QR Code

The web UI is already served by Railway at your public URL.  
Generate a QR code pointing to your Railway URL and print it.

Free QR generator: https://qr.io — enter your Railway URL.

---

## How It Works

1. User scans QR code → opens `https://xxxx.up.railway.app` (works on any internet)
2. Uploads a file (PDF, Word, image, etc.)
3. Clicks **Print**
4. Railway sends the job to the Windows agent via Socket.IO
5. Agent prints it silently on the connected printer

---

## File Types Supported

| Type | Method |
|------|--------|
| PDF | pdf-to-printer (Windows) |
| Word (.doc, .docx) | Microsoft Word via PowerShell |
| Images (jpg, png, etc.) | pdf-lib conversion + pdf-to-printer |
| Other | Windows Shell print verb |

---

## Agent Commands

```bat
:: Install as auto-start Windows Service (run as Admin)
install-service.bat

:: Uninstall the service
uninstall-service.bat

:: Run manually (for testing)
node agent.js

:: Check service status
sc query PrintScanAgent

:: View agent logs
type logs\agent-out.log
```

---

## Environment Variables

### Server (Railway Variables tab)
| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_SECRET` | Recommended | Shared secret to authenticate the print agent |

### Agent (`agent/.env`)
| Variable | Description |
|----------|-------------|
| `SERVER_URL` | Your Railway URL, e.g. `https://xxxx.up.railway.app` |
| `AGENT_SECRET` | Must match the Railway `AGENT_SECRET` variable |

---

## No Same-WiFi Needed

- The **phone** talks to **Railway** over any internet (mobile data, any WiFi)
- The **agent** talks to **Railway** over any internet
- They never need to be on the same network