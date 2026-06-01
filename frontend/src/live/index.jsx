// Live command post — Console / Cockpit / Explorer rendered as a NATIVE
// dashboard tab (not an embedded Praetorium shell). There is no `.pr-root`
// chrome and no Praetorium brand bar; the tab renders straight into the
// dashboard's `.a-main-area` / `.a-page-enter` wrapper (provided by app.jsx),
// so it shares the same theme, surfaces, and scroll context as every other
// tab. A ☰ flyout on the left (LiveFlyout) switches between the three views,
// mirroring the main nav rail.
//
// The session watcher is HOISTED to a module-level singleton (startLiveWatcher)
// that begins on the first mount and is never torn down, so switching views
// does NOT restart it. The Rust side keeps a single owning watcher
// (session_watch.rs), guaranteeing one stable live event sink for the session.

import React, { useEffect, useState } from "react";
import { Console } from "./components/console.jsx";
import { Cockpit } from "./components/cockpit.jsx";
import { Explorer } from "./components/explorer.jsx";
import { CommandPalette } from "./components/command-palette.jsx";
import { LiveRail } from "./components/view-switcher.jsx";

import { viewStore } from "./stores/view-store.js";
import { applyReduceMotion } from "./stores/settings.js";
import { applyWatch, refreshMetas } from "./stores/session-store.js";
import { watchSessions } from "./lib/sessions.js";
import { useStore } from "./stores/use-store.js";
import { applyThemeClass, themeIndexFromStorage, themeIndexFromId } from "../theme.js";
import { getTauriWindow } from "../tauri-window.js";

const ROUTES = { console: Console, cockpit: Cockpit, explorer: Explorer };

const hasTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const liveInvoke = async (cmd, args) => {
  if (!hasTauri()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
};

// ── Hoisted session watcher ────────────────────────────────────────────────
// Module-level singleton: starts once on the first Live mount and keeps running
// across view switches. We never stop the interval — the watcher is meant to
// live for the whole app session, matching the single owning watcher on the
// Rust side.
let liveWatcherStarted = false;
function startLiveWatcher() {
  if (liveWatcherStarted) return;
  liveWatcherStarted = true;
  // Fire-and-forget: not in a Tauri window during plain web/dev → no-op.
  watchSessions((e) => applyWatch(e, { external: true })).catch(() => {});
  refreshMetas().catch(() => {});
  setInterval(() => {
    refreshMetas().catch(() => {});
  }, 4000);
  applyReduceMotion();
}

// Shared Ctrl/⌘-K command-palette hook.
function usePalette() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [paletteOpen, setPaletteOpen];
}

// The native Live surface: a left ☰ flyout + the active view, rendered with
// the dashboard's own component vocabulary.
function LiveSurface() {
  const view = useStore(viewStore);
  const View = ROUTES[view] ?? Console;
  useEffect(() => { startLiveWatcher(); }, []);
  return (
    <div className="a-live-shell">
      <LiveRail />
      <div key={view} className="a-live-view">
        <View />
      </div>
    </div>
  );
}

// Centered placeholder shown in the docked tab while the Live view is running
// in its own pop-out window. "Bring it back" closes the pop-out (which re-emits
// live-window-closed, flipping us back to the live surface).
function DetachedPlaceholder() {
  return (
    <div className="a-live-detached">
      <div className="a-card a-live-detached-card">
        <div className="a-live-detached-title">Live is in its own window</div>
        <div className="a-live-detached-sub">
          The Live view popped out into a separate window. Bring it back here to
          dock it again.
        </div>
        <button
          type="button"
          className="a-live-detached-btn"
          onClick={() => liveInvoke("close_live_window")}
        >
          Bring it back
        </button>
      </div>
    </div>
  );
}

// Docked "live" route inside the main dashboard shell. app.jsx already wraps
// this in `.a-main-area > .a-page-enter`, so we return a fragment — no extra
// chrome, native theme. When the Live view is popped out into its own window,
// we render a placeholder here instead of a second live surface.
export function LiveTab() {
  const [paletteOpen, setPaletteOpen] = usePalette();
  const [poppedOut, setPoppedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlistenOpen;
    let unlistenClose;

    // Initialise from the backend's current window state.
    liveInvoke("is_live_window_open")
      .then((open) => { if (!cancelled) setPoppedOut(!!open); })
      .catch(() => {});

    // Track open/close events emitted by the backend.
    if (hasTauri()) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          Promise.all([
            listen("live-window-opened", () => setPoppedOut(true)),
            listen("live-window-closed", () => setPoppedOut(false)),
          ]),
        )
        .then(([off1, off2]) => {
          if (cancelled) { off1(); off2(); return; }
          unlistenOpen = off1;
          unlistenClose = off2;
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      if (unlistenOpen) unlistenOpen();
      if (unlistenClose) unlistenClose();
    };
  }, []);

  return (
    <>
      {poppedOut ? <DetachedPlaceholder /> : <LiveSurface />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

// Apply the dashboard's active theme to the pop-out window's own `.dir-a-root`.
// localStorage is per-origin (Tauri picks a fresh port each launch), so seed
// from it for an instant paint, then reconcile with the backend preference —
// the same source of truth the main window uses.
function applyLiveWindowTheme() {
  applyThemeClass(themeIndexFromStorage());
  fetch("/api/preferences", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      const i = themeIndexFromId(d && d.theme);
      if (i >= 0) applyThemeClass(i);
      // Mirror the main window's glass/acrylic: the backend applies the OS
      // vibrancy to the "live" window; this toggles the matching CSS layer
      // (translucent panels + frosted titlebar) when glass is enabled.
      const root = document.querySelector(".dir-a-root");
      if (root) {
        root.classList.toggle("is-glass", hasTauri() && !!d && !!d.glass_enabled);
        if (d && typeof d.glass_opacity === "number") {
          root.style.setProperty(
            "--glass-opacity",
            `${Math.max(0, Math.min(100, d.glass_opacity))}%`,
          );
        }
      }
    })
    .catch(() => {});
}

// Custom title bar for the decoration-less pop-out window. The bar itself is a
// drag region (move the window); the buttons minimize / maximize / dismiss.
// Close HIDES the window via close_live_window (a rebuilt window would not
// navigate) and re-docks the Live tab in the main window — it never quits the app.
function LiveTitlebar() {
  const act = (fn) => () => { const w = getTauriWindow(); if (w) fn(w); };
  return (
    <div className="a-live-titlebar">
      <span className="a-live-titlebar-title" data-tauri-drag-region>Live · Token Dashboard</span>
      <div className="a-live-titlebar-drag" data-tauri-drag-region />
      <div className="a-live-wincontrols">
        <button className="a-live-winbtn" aria-label="Minimize" onClick={act((w) => w.minimize())}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor" /></svg>
        </button>
        <button className="a-live-winbtn" aria-label="Maximize" onClick={act((w) => w.toggleMaximize())}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" /></svg>
        </button>
        <button className="a-live-winbtn a-live-winbtn-close" aria-label="Close" onClick={() => liveInvoke("close_live_window")}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </div>
  );
}

// Standalone popped-out window (mounted by entry.jsx on ?w=live-window). Wrapped
// in `.dir-a-root` so the native dashboard styles + active theme apply; the
// custom title bar provides drag + min/max/close since the window is
// decoration-less.
export function LiveWindow() {
  const [paletteOpen, setPaletteOpen] = usePalette();
  useEffect(() => { applyLiveWindowTheme(); }, []);
  return (
    <div className="dir-a-root a-live-window">
      <LiveTitlebar />
      <div className="a-live-window-body">
        <LiveSurface />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

// Re-export the pop-out invoke helper for any consumer that needs the
// open_live_window / close_live_window Tauri commands.
export { liveInvoke };
