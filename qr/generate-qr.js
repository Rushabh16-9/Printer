/**
 * Printer-by-Scanner — QR Code Generator
 *
 * Usage:
 *   node generate-qr.js --url http://192.168.x.x:3000
 *
 * Outputs:
 *   - qr-output.png  (save and print this)
 *   - Terminal QR code display
 */

const QRCode = require("qrcode");
const path = require("path");
const os = require("os");

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArgIdx = args.indexOf("--url");

// Auto-detect local IP if no URL provided
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

const url =
  urlArgIdx !== -1
    ? args[urlArgIdx + 1]
    : process.env.WEB_URL || `http://${getLocalIp()}:3000`;

const outputPath = path.join(__dirname, "qr-output.png");

// ─── Generate ─────────────────────────────────────────────────────────────────

async function generate() {
  console.log(`\n🔗 Generating QR code for URL: ${url}\n`);

  // Save PNG
  await QRCode.toFile(outputPath, url, {
    width: 512,
    margin: 2,
    color: {
      dark: "#1a1a2e",
      light: "#ffffff",
    },
  });

  console.log(`✅ QR code saved to: ${outputPath}`);
  console.log("   Print this file and place it where users can scan it.\n");

  // Terminal display
  const terminalQR = await QRCode.toString(url, { type: "terminal", small: true });
  console.log(terminalQR);

  console.log(`\n📱 Users scan the QR → browser opens: ${url}`);
  console.log("   Make sure the web server is running on that address.\n");
}

generate().catch((err) => {
  console.error("❌ Failed to generate QR code:", err.message);
  process.exit(1);
});
