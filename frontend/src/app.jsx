import React, { useEffect, useState } from "react";
import { Topbar } from "./components/topbar.jsx";
import { Overview } from "./routes/overview.jsx";
import { Prompts } from "./routes/prompts.jsx";
import { Sessions } from "./routes/sessions.jsx";
import { Settings } from "./routes/settings.jsx";
import { Tips } from "./routes/tips.jsx";
import { Work } from "./routes/work.jsx";
import { ApiRoute } from "./routes/api.jsx";
import {
  applyThemeClass,
  persistThemeBackend,
  persistThemeIndex,
  themeIndexFromId,
  themeIndexFromStorage,
} from "./theme.js";
import { useAdvancedMode } from "./use-advanced-mode.js";

const ADVANCED_TABS = new Set(["api"]);

const ROUTES = {
  overview: Overview,
  prompts: Prompts,
  sessions: Sessions,
  "token sink": Work,
  tips: Tips,
  api: ApiRoute,
  settings: Settings,
};

const firstHashSegment = () => {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  return (raw.split("/")[0] || "").toLowerCase();
};

const tabFromHash = () => {
  const h = firstHashSegment();
  if (h === "tokensink" || h === "token-sink" || h === "work") return "token sink";
  return Object.keys(ROUTES).includes(h) ? h : "overview";
};

const tabToSlug = (tab) => (tab === "token sink" ? "token-sink" : tab);

const useHashRouter = (initialTab, lockTab) => {
  const [tab, setTab] = useState(initialTab || tabFromHash());
  useEffect(() => {
    if (lockTab && initialTab) setTab(initialTab);
  }, [initialTab, lockTab]);
  useEffect(() => {
    if (lockTab) return;
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [lockTab]);
  useEffect(() => {
    if (lockTab) return;
    const want = tabToSlug(tab);
    if (firstHashSegment() !== want) window.location.hash = `/${want}`;
  }, [tab, lockTab]);
  return [tab, setTab];
};

const useRangeReload = (range) => {
  const [, setNonce] = useState(0);
  useEffect(() => {
    if (!window.RELOAD_DATA) return;
    let cancelled = false;
    window.RELOAD_DATA(range).then(() => {
      if (!cancelled) setNonce((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [range]);
  // Re-render on SSE-driven MOCK_DATA refreshes so the dashboard stays
  // live even when the user isn't interacting with the app.
  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener("td:data", bump);
    return () => window.removeEventListener("td:data", bump);
  }, []);
};

const useTheme = () => {
  const [themeIdx, setThemeIdx] = useState(themeIndexFromStorage);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    applyThemeClass(themeIdx);
    persistThemeIndex(themeIdx);
    if (hydrated) persistThemeBackend(themeIdx);
  }, [themeIdx, hydrated]);
  // Tauri's webview origin is a fresh ephemeral port each launch, so
  // localStorage is effectively per-session. Pull the backend's stored
  // theme on mount and reconcile if it differs.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const i = themeIndexFromId(d && d.theme);
        if (i >= 0) setThemeIdx(i);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);
  return [themeIdx, setThemeIdx];
};

const useGlassBootstrap = () => {
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const root = document.querySelector(".dir-a-root");
        if (!root) return;
        // Glass only applies inside the Electron app where the BrowserWindow
        // is configured with vibrancy/acrylic. In a plain browser there is no
        // transparent surface behind the page, so stripping the body would
        // expose the browser's default white background.
        const isElectron = !!window.td;
        const wantGlass = isElectron && !!(d && d.glass_enabled);
        root.classList.toggle("is-glass", wantGlass);
        if (d && typeof d.glass_opacity === "number") {
          const v = Math.max(0, Math.min(100, d.glass_opacity));
          root.style.setProperty("--glass-opacity", `${v}%`);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
};

export const DirectionA = ({ initialTab, lockTab = false }) => {
  const [tab, setTab] = useHashRouter(initialTab, lockTab);
  const [range, setRange] = useState("30d");
  const [themeIdx, setThemeIdx] = useTheme();
  const [advancedMode, advancedLoaded] = useAdvancedMode();
  useGlassBootstrap();
  useRangeReload(range);
  // Bounce off an advanced-only tab as soon as we know the toggle is off,
  // so users can't linger on hidden routes after disabling advanced mode.
  useEffect(() => {
    if (!advancedLoaded || lockTab) return;
    if (!advancedMode && ADVANCED_TABS.has(tab)) setTab("overview");
  }, [advancedLoaded, advancedMode, tab, lockTab, setTab]);
  const effectiveTab = !advancedMode && ADVANCED_TABS.has(tab) ? "overview" : tab;
  const Route = ROUTES[effectiveTab] || Overview;
  return (
    <>
      <Topbar tab={effectiveTab} setTab={setTab} range={range} setRange={setRange} advancedMode={advancedMode} />
      <main className="a-main-area">
        <Route themeIdx={themeIdx} onPickTheme={setThemeIdx} advancedMode={advancedMode} />
      </main>
    </>
  );
};
