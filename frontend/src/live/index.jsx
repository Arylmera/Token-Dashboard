// Live command post — Praetorium's Console / Cockpit / Explorer mounted as a
// Token Dashboard sub-surface. Two hosts share one inner `LiveSurface`:
//   • LiveTab    — the docked "live" route inside the main dashboard shell.
//   • LiveWindow — the popped-out standalone window (#live-window).
// The surface owns the session watcher; the Rust side keeps a single owning
// watcher (see session_watch.rs), so whichever host is mounted is the live
// event sink. The docked tab collapses to a placeholder while the pop-out is
// open, driven by the live-window-opened / live-window-closed events.

import React, { useEffect, useState } from "react";
import { Console } from "./components/console.jsx";
import { Cockpit } from "./components/cockpit.jsx";
import { Explorer } from "./components/explorer.jsx";
import { Settings } from "./components/settings.jsx";
import { CommandPalette } from "./components/command-palette.jsx";
import { ViewSwitcher } from "./components/view-switcher.jsx";

import { viewStore, setView } from "./stores/view-store.js";
import { vaultPathStore } from "./stores/vault-store.js";
import {
  glassStore,
  layoutNameStore,
  applyReduceMotion,
} from "./stores/settings.js";
import { themeStore, themedCopy } from "./themes/theme.js";
import { applyWatch, refreshMetas } from "./stores/session-store.js";
import { watchSessions } from "./lib/sessions.js";
import { useStore } from "./stores/use-store.js";

const ROUTES = { console: Console, cockpit: Cockpit, explorer: Explorer, settings: Settings };

const hasTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const liveInvoke = async (cmd, args) => {
  if (!hasTauri()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
};

// The actual Console/Cockpit/Explorer surface. Owns the session watcher for
// the duration it's mounted.
function LiveSurface() {
  const view = useStore(viewStore);
  const glass = useStore(glassStore);
  const layoutName = useStore(layoutNameStore);
  const theme = useStore(themeStore);
  const vaultPath = useStore(vaultPathStore);

  const vaultName = (() => {
    const p = (vaultPath || "").replace(/\\/g, "/").split("/").filter(Boolean).pop();
    return p || "no vault";
  })();

  useEffect(() => {
    let cancelled = false;
    let intervalId = null;
    // Fire-and-forget: not in a Tauri window during plain web/dev → no-op.
    watchSessions((e) => applyWatch(e, { external: true })).catch(() => {});
    refreshMetas().catch(() => {});
    intervalId = setInterval(() => {
      if (!cancelled) refreshMetas().catch(() => {});
    }, 4000);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    applyReduceMotion();
  }, []);

  const View = ROUTES[view] ?? Console;
  const tCopy = themedCopy();

  return (
    <div className={"pr-root" + (glass ? " is-glass" : "")} data-theme={theme}>
      <div className="pr-live-bar">
        <ViewSwitcher />
        <span className="pr-brand-sub">
          {tCopy?.cmd ?? "live"} · {vaultName} · layout {layoutName}
        </span>
      </div>
      <main className="pr-live-main">
        <div key={view} className="pr-page-enter">
          <View />
        </div>
      </main>
    </div>
  );
}

// Docked route. Renders the surface, plus a pop-out control; while the
// standalone window is open it shows a "running in its own window" placeholder.
export function LiveTab() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);

  useEffect(() => {
    let unlisten = [];
    liveInvoke("is_live_window_open").then((v) => setPoppedOut(!!v));
    if (hasTauri()) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen("live-window-opened", () => setPoppedOut(true)).then((u) => unlisten.push(u));
        listen("live-window-closed", () => setPoppedOut(false)).then((u) => unlisten.push(u));
      });
    }
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlisten.forEach((u) => u && u());
    };
  }, []);

  if (poppedOut) {
    return (
      <div className="pr-root pr-live-detached">
        <p>Live is open in its own window.</p>
        <button className="pr-navlink" onClick={() => liveInvoke("close_live_window")}>
          Bring it back
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="pr-live-host">
        <button
          className="pr-navlink pr-live-popout"
          title="Open Live in its own window"
          onClick={() => liveInvoke("open_live_window")}
        >
          ⤢ pop out
        </button>
        <LiveSurface />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

// Standalone popped-out window (mounted by entry.jsx on #live-window).
export function LiveWindow() {
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
  return (
    <div className="pr-live-window" data-tauri-drag-region="">
      <LiveSurface />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
