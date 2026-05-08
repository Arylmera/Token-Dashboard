"use strict";

// SSE subscriber for /api/stream — invokes onTick on each frame, with a
// fixed reconnect delay on error or end-of-stream.

const http = require("http");

const SSE_RECONNECT_MS = 2000;

function createSSEClient({ getBackendUrl, onTick }) {
  let request = null;
  let stopped = false;

  function scheduleReconnect() {
    if (request) {
      try { request.destroy(); } catch (_) {}
      request = null;
    }
    if (stopped) return;
    setTimeout(() => { if (!stopped) connect(); }, SSE_RECONNECT_MS);
  }

  function connect() {
    const backendUrl = getBackendUrl();
    if (!backendUrl) return;
    const u = new URL("/api/stream", backendUrl);
    request = http.get(
      { host: u.hostname, port: u.port, path: u.pathname, headers: { "Accept": "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }
        res.setEncoding("utf-8");
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.startsWith(":")) continue; // keep-alive ping
            const line = frame.replace(/^data:\s*/, "").trim();
            if (!line) continue;
            let payload = null;
            try { payload = JSON.parse(line); } catch (_) {}
            onTick(payload);
          }
        });
        res.on("end", scheduleReconnect);
        res.on("error", scheduleReconnect);
      },
    );
    request.on("error", scheduleReconnect);
  }

  function stop() {
    stopped = true;
    if (request) {
      try { request.destroy(); } catch (_) {}
      request = null;
    }
  }

  return { connect, stop };
}

module.exports = { createSSEClient };
