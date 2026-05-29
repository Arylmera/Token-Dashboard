// Single source of truth for power-level gating. Imported by topbar.jsx
// (tab visibility) and overview.jsx (card visibility). Levels are
// cumulative: a user at level N sees everything tagged <= N.

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 4;

export const LEVELS = [
  { id: 1, key: "basic",    label: "Basic",    blurb: "Live spend, burn rate, and plan limits — the essentials." },
  { id: 2, key: "standard", label: "Standard", blurb: "Adds daily charts, sessions, calendar, budget, and tips." },
  { id: 3, key: "advanced", label: "Advanced", blurb: "Adds project / model / tool breakdowns, cache, prompts, tags, and editable internals." },
  { id: 4, key: "expert",   label: "Expert",   blurb: "Everything: token sink, API tab, anomaly detection, model efficiency." },
];

export const TAB_MIN_LEVEL = {
  overview: 1,
  settings: 1,
  budget: 2,
  sessions: 2,
  calendar: 2,
  tips: 2,
  cache: 3,
  prompts: 3,
  tags: 3,
  "token sink": 4,
  api: 4,
  live: 2,
};

export const CARD_MIN_LEVEL = {
  topStrip: 1,
  budgetAlertBanner: 1,
  budgetBanner: 1,
  limitsCard: 1,
  burnRateCard: 1,
  kpiRow: 2,
  dailyCharts: 2,
  recentSessions: 2,
  projectsTable: 3,
  modelsCard: 3,
  phaseSplit: 3,
  topTools: 3,
  modelLeaderboard: 4,
  anomaly: 4,
};

export const clampLevel = (n) => {
  const i = Math.round(Number(n));
  return Number.isFinite(i) ? Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, i)) : MIN_LEVEL;
};

export const tabVisible = (level, tab) => (TAB_MIN_LEVEL[tab] ?? 1) <= level;
export const cardVisible = (level, key) => (CARD_MIN_LEVEL[key] ?? 1) <= level;
