const http = require("http");
const { spawn } = require("child_process");

let currentQR = null;
let status = "Connecting to server...";

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function fetchQR() {
  status = "Fetching QR from server...";
  currentQR = null;

  const ssh = spawn("ssh", [
    "-i", `${process.env.HOME}/.ssh/hostinger`,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "root@72.60.165.134",
    "openclaw channels login --channel whatsapp --account airsup 2>&1"
  ]);

  let buf = "";
  let lines = [];
  let capturing = false;

  ssh.stdout.on("data", (data) => {
    buf += data.toString();
    const parts = buf.split("\n");
    buf = parts.pop();

    for (const raw of parts) {
      const line = stripAnsi(raw);
      if (line.includes("scan this QR")) {
        capturing = true;
        lines = [];
        continue;
      }
      if (capturing) {
        if (line.trim() === "" && lines.length > 5) {
          capturing = false;
          currentQR = lines.join("\n");
          status = "QR ready — scan with WhatsApp → Linked Devices → Link a Device";
          console.log("QR captured, serving at http://localhost:3000");
        } else {
          lines.push(line);
        }
      }
    }
  });

  ssh.on("close", () => {
    if (!currentQR) status = "QR expired or login failed. Refresh to try again.";
  });
}

fetchQR();

const HTML = (qr, msg) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="refresh" content="30"/>
  <title>WhatsApp QR · Airsup</title>
  <style>
    body { background:#fff; display:flex; flex-direction:column; align-items:center;
           justify-content:center; min-height:100vh; font-family:sans-serif; margin:0; }
    pre { font-family:monospace; font-size:7px; line-height:1.1; letter-spacing:0;
          background:#fff; color:#000; padding:16px; border-radius:8px;
          box-shadow:0 2px 12px rgba(0,0,0,0.12); }
    p { color:#444; font-size:14px; margin-bottom:24px; text-align:center; max-width:400px; }
    button { margin-top:20px; padding:10px 24px; font-size:14px; cursor:pointer;
             border:1px solid #ccc; border-radius:8px; background:#f5f5f5; }
  </style>
</head>
<body>
  <p>${msg}</p>
  ${qr ? `<pre>${qr}</pre>` : `<p style="color:#888">Waiting for QR code...</p>`}
  <button onclick="location.reload()">Refresh QR</button>
</body>
</html>`;

http.createServer((req, res) => {
  if (req.url === "/refresh") {
    currentQR = null;
    status = "Fetching new QR...";
    fetchQR();
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML(currentQR, status));
}).listen(3000, () => {
  console.log("Open http://localhost:3000 in your browser");
});
