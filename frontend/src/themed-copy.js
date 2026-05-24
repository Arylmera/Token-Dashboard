// Per-theme UI string overrides for the three special themes. Only the
// special themes rewrite copy; every other theme renders the default English
// strings, so callers fall back when getThemedCopy() returns null.
//
// The live app has more nav tabs / KPIs / columns than the prototype's mock,
// so only the genuinely nameable surfaces are mapped here — anything absent
// from a theme's table falls through to the default string.

const COPY = {
  terminal: {
    brand: { path: "C:\\TD>", ps1: "$", cmd: "TD.EXE" },
    nav: { overview: "OVERVIEW", prompts: "PROMPTS", sessions: "SESSIONS", budget: "BUDGET", settings: "SETTINGS" },
    kpi: { "cache hit": "CACHE HIT" },
    col: { session: "SESSION", model: "MODEL" },
    card: { "Recent sessions": "RECENT SESSIONS", "By model": "MODELS" },
    versionMeta: (v) => `v${v} · BBS UTC`,
  },
  cockpit: {
    brand: { path: "BRIDGE", ps1: "›", cmd: "TD.SYS" },
    nav: { overview: "OVERVIEW", prompts: "CHANNELS", sessions: "SORTIES", budget: "RESERVES", settings: "CONFIG" },
    kpi: { "cache hit": "CACHE · LINK" },
    col: { session: "CALL-SIGN", model: "PLATFORM" },
    card: { "Recent sessions": "SORTIE LOG", "By model": "PLATFORMS" },
    versionMeta: (v) => `SYS v${v} · LINK STABLE`,
  },
  grimdark: {
    brand: { path: "~/forge/vigil", ps1: "✠", cmd: "vigil" },
    nav: { overview: "LITANY", prompts: "RITES", sessions: "MUSTER", budget: "TREASURY", settings: "RUBRIC" },
    kpi: { "cache hit": "SCROLLS RECALLED" },
    col: { session: "NAME", model: "VESSEL" },
    card: { "Recent sessions": "RECENT RITES", "By model": "VESSELS OF THE CHOIR" },
    versionMeta: (v) => `vigil ${String(v).replace(/\./g, "·")} · candle lit`,
  },
};

export const getThemedCopy = (themeId) => COPY[themeId] || null;
