import React, { useEffect, useState } from "react";
import { Topbar } from "./components/topbar.jsx";
import { Overview } from "./routes/overview.jsx";
import { Budget } from "./routes/budget.jsx";
import { Cache } from "./routes/cache.jsx";
import { Prompts } from "./routes/prompts.jsx";
import { Sessions } from "./routes/sessions.jsx";
import { Calendar } from "./routes/calendar.jsx";
import { Tags } from "./routes/tags.jsx";
import { Settings } from "./routes/settings.jsx";
import { Tips } from "./routes/tips.jsx";
import { Work } from "./routes/work.jsx";
import { ApiRoute } from "./routes/api.jsx";
import { LiveTab } from "./live/index.jsx";
import {
  THEMES,
  SPECIAL_THEME_IDS,
  applyThemeClass,
  persistThemeBackend,
  persistThemeIndex,
  themeIndexFromId,
  themeIndexFromStorage,
} from "./theme.js";
import { AmbientLayer } from "./components/ambient-canvas.jsx";
import { NavRail } from "./components/nav-rail.jsx";
import { WindowResizeHandles } from "./components/window-resize-handles.jsx";
import { ThemeBanner, CockpitHud, useCockpitBrackets } from "./components/special-chrome.jsx";
import { useCalmFx } from "./fx-pref.js";
import { usePowerLevel } from "./use-power-level.js";
import { tabVisible } from "./levels.js";

const ROUTES = {
  overview: Overview,
  budget: Budget,
  cache: Cache,
  prompts: Prompts,
  sessions: Sessions,
  calendar: Calendar,
  tags: Tags,
  "token sink": Work,
  tips: Tips,
  api: ApiRoute,
  live: LiveTab,
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

const useRangeReload = (range, provider, multiProviderEnabled) => {
  const [, setNonce] = useState(0);
  useEffect(() => {
    if (!window.RELOAD_DATA) return;
    let cancelled = false;
    const effective = multiProviderEnabled ? provider : "all";
    if (window.SET_PROVIDER) window.SET_PROVIDER(effective);
    window.RELOAD_DATA(range).then(() => {
      if (!cancelled) setNonce((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [range, provider, multiProviderEnabled]);
  // Re-render on SSE-driven MOCK_DATA refreshes so the dashboard stays
  // live even when the user isn't interacting with the app.
  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener("td:data", bump);
    return () => window.removeEventListener("td:data", bump);
  }, []);
};

const useMultiProviderPref = () => {
  const [enabled, setEnabled] = useState(false);
  const refresh = () => {
    fetch("/api/preferences", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d.multi_provider_enabled === "boolean") {
          setEnabled(d.multi_provider_enabled);
        }
      })
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
    // Settings page triggers RELOAD_STATIC after toggling — piggyback on the
    // same signal so the topbar reflects the change without a full reload.
    const prev = window.RELOAD_STATIC;
    if (typeof prev === "function") {
      window.RELOAD_STATIC = async (...args) => {
        const out = await prev.apply(window, args);
        refresh();
        return out;
      };
      return () => { window.RELOAD_STATIC = prev; };
    }
  }, []);
  return enabled;
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
  const [provider, setProvider] = useState("all");
  const [themeIdx, setThemeIdx] = useTheme();
  const [level, levelLoaded] = usePowerLevel();
  const multiProviderEnabled = useMultiProviderPref();
  useGlassBootstrap();
  useRangeReload(range, provider, multiProviderEnabled);
  // Bounce off any tab above the user's level once we know it, so users
  // can't linger on hidden routes after lowering their level.
  useEffect(() => {
    if (!levelLoaded || lockTab) return;
    if (!tabVisible(level, tab)) setTab("overview");
  }, [levelLoaded, level, tab, lockTab, setTab]);
  const effectiveTab = (lockTab || !levelLoaded || tabVisible(level, tab)) ? tab : "overview";
  const Route = ROUTES[effectiveTab] || Overview;
  const themeId = THEMES[themeIdx]?.id;
  const themeCls = THEMES[themeIdx]?.cls || "";
  const isSpecial = SPECIAL_THEME_IDS.has(themeId);
  const [calmFx] = useCalmFx();
  useCockpitBrackets(themeId === "cockpit");
  // Toggle the calm-motion class on the wrapper so banner/scanline/blip CSS
  // animations can be paused alongside the (JS) ambient canvas.
  useEffect(() => {
    const root = document.querySelector(".dir-a-root");
    if (root) root.classList.toggle("is-calm-fx", isSpecial && calmFx);
  }, [isSpecial, calmFx]);
  return (
    <div className="a-shell">
      <AmbientLayer themeCls={isSpecial && !calmFx ? themeCls : ""} />
      <WindowResizeHandles />
      <NavRail tab={effectiveTab} setTab={setTab} level={level} themeId={themeId} />
      <div className="a-shell-main">
        <Topbar range={range} setRange={setRange} provider={provider} setProvider={multiProviderEnabled ? setProvider : null} themeId={themeId} />
        <ThemeBanner themeId={themeId} />
        <main className="a-main-area">
          <div key={effectiveTab} className="a-page-enter">
            <Route themeIdx={themeIdx} themeId={themeId} onPickTheme={setThemeIdx} level={level} />
          </div>
        </main>
        {themeId === "cockpit" && <CockpitHud />}
      </div>
    </div>
  );
};
