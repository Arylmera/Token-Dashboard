import React from "react";
import { createRoot } from "react-dom/client";
import { DirectionA } from "./src/app.jsx";
import { Widget } from "./src/widget.jsx";
import { SetupHelpWindow } from "./src/setup-help.jsx";
import { LiveWindow } from "./src/live/index.jsx";
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

// Pause looping animations (pulses, scanlines, blinking carets) while the
// window is unfocused: on a glass window they kept the GPU + renderer
// processes at ~65% of a core, and WebView2 never flips document.hidden for
// a background window. One-shot entrances are left alone so content that
// fades in from opacity 0 always finishes, even in a never-focused widget.
const _looping = (a) => a.effect && a.effect.getComputedTiming().iterations === Infinity;
let _focused = document.hasFocus();
const _setFocused = (f) => {
  _focused = f;
  for (const a of document.getAnimations()) if (_looping(a)) (f ? a.play() : a.pause());
};
window.addEventListener("blur", () => _setFocused(false));
window.addEventListener("focus", () => _setFocused(true));
// Native focus too: the DOM events can lag when the window is minimized.
try {
  window.__TAURI__.window.getCurrentWindow().onFocusChanged((e) => _setFocused(!!e.payload)).catch(() => {});
} catch (_) {}
// Loops that start while unfocused (e.g. the fresh-data pulse after a scan).
document.addEventListener("animationstart", (e) => {
  if (!_focused) for (const a of e.target.getAnimations({ subtree: true })) if (_looping(a)) a.pause();
}, true);

// Spawned windows (widget / setup-help / live) are routed via a `?w=<name>`
// query param rather than a `#hash`, because WebView2's initial navigation
// no-ops on fragment-only URLs and leaves the window blank. The hash forms are
// still accepted for backward compatibility.
const winParam = () => {
  try { return new URLSearchParams(window.location.search).get("w") || ""; }
  catch (_) { return ""; }
};

const isWidget = () => {
  try {
    if (winParam() === "widget" || window.location.hash === "#widget") return true;
    return /widget\.html?$/i.test(window.location.pathname);
  } catch (_) { return false; }
};

const isSetupHelp = () => {
  try { return winParam() === "setup-help" || window.location.hash === "#setup-help"; }
  catch (_) { return false; }
};

const isLiveWindow = () => {
  try { return winParam() === "live-window" || window.location.hash === "#live-window"; }
  catch (_) { return false; }
};

const Shell = () => (
  <div className="dir-a-root" style={{ height: "100vh" }}>
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
  if (isLiveWindow()) {
    document.body.classList.add("td-live-window-body");
    root.render(<LiveWindow />);
    return;
  }
  if (isSetupHelp()) {
    document.body.classList.add("td-setup-help-body");
    root.render(<SetupHelpWindow />);
    return;
  }
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
