"use strict";

// Backend lifecycle: pick the right Python invocation, spawn it, wait until
// it prints the ready token (or /api/health responds), and tear it down on
// shutdown. Pure functions — no module-level state.

const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const READY_TOKEN = "TOKEN_DASHBOARD_READY";

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function pythonCommand({ isPackaged, isWin, dirname }) {
  // Packaged app: prefer the bundled PyInstaller exe shipped in extraResources.
  if (isPackaged) {
    const resBase = process.resourcesPath || path.join(dirname, "resources");
    const exeName = isWin ? "token-dashboard.exe" : "token-dashboard";
    const bundled = path.join(resBase, "py", exeName);
    if (fs.existsSync(bundled)) {
      return { cmd: bundled, args: ["dashboard", "--no-open", "--no-scan"] };
    }
  }
  // Dev: probe the user's Python.
  const py = process.env.PYTHON || (isWin ? "py" : "python3");
  const args = isWin && py === "py"
    ? ["-3", "-m", "token_dashboard", "dashboard", "--no-open", "--no-scan"]
    : ["-m", "token_dashboard", "dashboard", "--no-open", "--no-scan"];
  return { cmd: py, args };
}

function spawnBackend({ port, repoRoot, isPackaged, isWin, dirname }) {
  const { cmd, args } = pythonCommand({ isPackaged, isWin, dirname });
  const env = Object.assign({}, process.env, {
    HOST: "127.0.0.1",
    PORT: String(port),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  });
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.on("error", (err) => console.error("[backend] spawn error:", err));
  child.on("exit", (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForReady(child, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let buf = "";
    let readyPayload = null;

    const finishOk = () => {
      if (resolved) return;
      resolved = true;
      resolve({ url: `http://127.0.0.1:${port}/`, readyPayload });
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith(READY_TOKEN)) {
          const jsonPart = line.slice(READY_TOKEN.length).trim();
          try { readyPayload = JSON.parse(jsonPart); } catch (_) { readyPayload = null; }
          finishOk();
        } else if (line) {
          console.log(`[backend] ${line}`);
        }
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => process.stderr.write(`[backend:err] ${chunk}`));

    const startedAt = Date.now();
    const poll = () => {
      if (resolved) return;
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          if (resolved) return;
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body);
              if (parsed && parsed.ok) { finishOk(); return; }
            } catch (_) {}
          }
          if (Date.now() - startedAt < timeoutMs) setTimeout(poll, 300);
        });
      });
      req.on("error", () => {
        if (Date.now() - startedAt < timeoutMs) setTimeout(poll, 300);
      });
      req.on("timeout", () => req.destroy());
    };
    setTimeout(poll, 600);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Backend did not become ready within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

function killBackend(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch (_) {}
  }
  try { child.kill(); } catch (_) {}
}

module.exports = { probeFreePort, spawnBackend, waitForReady, killBackend };
