import React from "react";
import { createRoot } from "react-dom/client";
import { DirectionA } from "./src/app.jsx";
import { Widget } from "./src/widget.jsx";
import "./src/api-client.js";

// Tauri shell bridge. v3 used an Electron preload to expose `window.td`;
// v4 reaches the runtime through `window.__TAURI__.core.invoke`. Keep the
// same surface so settings cards (glass, devtools, badge) stay agnostic.
try {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  if (invoke) {
    const ua = (navigator.userAgent || "").toLowerCase();
    const platform = ua.includes("mac") ? "darwin"
      : ua.includes("win") ? "win32"
      : ua.includes("linux") ? "linux"
      : "";
    window.td = Object.assign(window.td || {}, {
      platform,
      setGlass: (on) => invoke("set_glass", { on: !!on }).catch(() => {}),
    });
  }
} catch (_) {}

const isWidget = () => {
  try {
    if (window.location.hash === "#widget") return true;
    return /widget\.html?$/i.test(window.location.pathname);
  } catch (_) { return false; }
};

const Shell = () => (
  <div className="dir-a-root" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <DirectionA />
  </div>
);

(async () => {
  await window.DATA_READY;
  // Tag the body with the host platform so CSS can reserve space for the
  // native window controls on the correct side (mac=left, win=right).
  try {
    const plat = (window.td && window.td.platform) || "";
    if (plat) document.body.classList.add(`platform-${plat}`);
  } catch (_) {}
  const root = createRoot(document.getElementById("root"));
  if (isWidget()) {
    // widget.html ships this class on <body>; when we mount via the
    // index.html route (with #widget), apply it here so the
    // widget-only CSS (hide scrollbars, lock overflow) takes effect.
    document.body.classList.add("td-widget-body");
    root.render(<Widget />);
    return;
  }
  const render = () => root.render(<Shell />);
  render();
  try {
    const d = localStorage.getItem("td.density.v1");
    if (d && d !== "comfortable") {
      const r = document.querySelector(".dir-a-root");
      if (r) r.setAttribute("data-density", d);
    }
  } catch (_) {}
  try {
    const es = new EventSource("/api/stream");
    es.onmessage = async (e) => {
      let evt = null;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (!evt) return;
      if (evt.type === "bundle") {
        // Dev mode: esbuild rebuilt dist/app.js, hard-reload to pick it up.
        location.reload();
        return;
      }
      if (evt.type !== "scan") return;
      if (evt.changed && window.RELOAD_DELTA) {
        await window.RELOAD_DELTA(evt.changed);
      } else {
        await window.RELOAD_DATA();   // fallback for old server / missing changed
      }
      render();
    };
  } catch (_) {}
})();
