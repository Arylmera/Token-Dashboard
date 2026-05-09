// Real-data adapter for the React UI.
// Fetches /api/* endpoints and shapes them into the MOCK_DATA contract the
// React component expects. Imported for side effects by entry.jsx — it
// resolves window.DATA_READY before mounting and exposes window.RELOAD_DATA
// for range switches and SSE refreshes.

import { pickEntries, pickStaticEntries } from "./sse-dispatch.js";

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `Today ${hh}:${mm}`;
  if (isYest) return `Yesterday ${hh}:${mm}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ` ${hh}:${mm}`;
};

const relTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400 / 7)}w ago`;
  if (sec < 86400 * 365) return `${Math.floor(sec / 86400 / 30)}mo ago`;
  return `${Math.floor(sec / 86400 / 365)}y ago`;
};

const shortModel = (m) => {
  if (!m) return "unknown";
  const s = m.toLowerCase();
  const major = (s.match(/\d+(?:[.-]\d+)?/) || [""])[0].replace("-", ".");
  if (s.includes("opus")) return "Opus" + (major ? " " + major : "");
  if (s.includes("sonnet")) return "Sonnet" + (major ? " " + major : "");
  if (s.includes("haiku")) return "Haiku" + (major ? " " + major : "");
  return m;
};

const shortDate = (yyyymmdd) => {
  if (!yyyymmdd) return "";
  const d = new Date(yyyymmdd);
  if (isNaN(d)) return yyyymmdd;
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
};

const j = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
};

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "all": null };
const RANGE_LABELS = { "1d": "1 day", "7d": "7 days", "30d": "30 days", "90d": "90 days", "all": "all-time" };

const billable = (o) => (o.input_tokens || 0) + (o.output_tokens || 0)
  + (o.cache_create_5m_tokens || 0) + (o.cache_create_1h_tokens || 0);

const totalTokens = (o) => billable(o) + (o.cache_read_tokens || 0);

let currentRange = "30d";

// Endpoint registry. Each entry declares:
//   key       — slot in MOCK_DATA the result lands in
//   url(ctx)  — URL builder, given { rangeSince, range }
//   trigger   — "any" | "static" | "sessions" | "projects" | "models" | "days"
//   windowSince(range) — only for ["days"]; returns ISO since-bound or null
//   fallback() — only for endpoints that may legitimately 404 / error; called on fetch failure
//
// loadAll runs every entry. (Tasks 4–5 add loadDelta + loadStatic.)
const REG = [
  { key: "overviewAll",   trigger: "any",   url: () => "/api/overview" },
  { key: "overview30",    trigger: "days",  windowSince: () => isoDaysAgo(30), url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(30))}` },
  { key: "overview7",     trigger: "days",  windowSince: () => isoDaysAgo(7),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(7))}` },
  { key: "overviewToday", trigger: "days",  windowSince: () => isoDaysAgo(0),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(0))}` },
  { key: "overviewYday",  trigger: "days",  windowSince: () => isoDaysAgo(1),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(1))}&until=${encodeURIComponent(isoDaysAgo(0))}` },
  { key: "overviewRange", trigger: "days",  windowSince: (r) => r, url: ({ rangeSince }) => `/api/overview${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "daily",         trigger: "days",  windowSince: (r) => r, url: ({ rangeSince }) => `/api/daily${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "projects",      trigger: "projects", url: ({ rangeSince }) => `/api/projects${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "tools",         trigger: "any",   url: ({ rangeSince }) => `/api/tools${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "sessionsRaw",   trigger: "sessions", url: ({ rangeSince }) => `/api/sessions?${rangeSince ? `since=${encodeURIComponent(rangeSince)}&` : ""}limit=50` },
  { key: "skills",        trigger: "any",   url: ({ rangeSince }) => `/api/skills${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "byModel",       trigger: "models", url: ({ rangeSince }) => `/api/by-model${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "prompts",       trigger: "sessions", url: ({ rangeSince }) => `/api/prompts?${rangeSince ? `since=${encodeURIComponent(rangeSince)}&` : ""}limit=20&sort=tokens` },
  { key: "hourlyRaw",     trigger: "days",  windowSince: () => isoDaysAgo(1), url: () => "/api/hourly?hours=24", fallback: () => [] },
  { key: "tips",          trigger: "any",   url: () => "/api/tips", fallback: () => [] },
  { key: "planResp",      trigger: "static", url: () => "/api/plan",   fallback: () => ({ plan: "max" }) },
  { key: "limitsResp",    trigger: "static", url: () => "/api/limits", fallback: () => null },
  { key: "budgetResp",    trigger: "static", url: () => "/api/budget", fallback: () => null },
  { key: "phaseResp",     trigger: "any",   url: ({ rangeSince }) => `/api/phase-split${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}`, fallback: () => null },
  { key: "tagsResp",      trigger: "static", url: () => "/api/tags", fallback: () => [] },
  { key: "prefsResp",     trigger: "static", url: () => "/api/preferences", fallback: () => null },
];

const _cache = {};   // last-known raw value per key, mutated by _fetchKeys

async function _fetchKeys(keys, ctx) {
  const tasks = keys.map(async (k) => {
    const entry = REG.find((e) => e.key === k);
    try {
      const v = await j(entry.url(ctx));
      _cache[k] = v;
    } catch (err) {
      if (entry.fallback) _cache[k] = entry.fallback();
      else throw err;
    }
  });
  await Promise.all(tasks);
}

function _ctx(range) {
  const days = RANGE_DAYS[range];
  return { range, rangeSince: days == null ? null : isoDaysAgo(days) };
}

function _rebuildMockData(range) {
  const c = _cache;
  const totals = buildTotals(range, c.overviewAll || {}, c.overview30 || {}, c.overview7 || {}, c.overviewToday || {}, c.overviewYday || {}, c.overviewRange || {});
  const hourly = buildHourly(c.hourlyRaw || []);
  window.MOCK_DATA = {
    totals,
    daily:    buildDaily(c.daily || [], totals.range),
    projects: buildProjects(c.projects || [], totals.range),
    models:   buildModels(c.byModel || []),
    tools:    (c.tools || []).map((t) => ({ name: t.tool_name, calls: t.calls || 0, tokens: t.result_tokens || 0 })),
    sessions: buildSessions(c.sessionsRaw || []),
    prompts:  buildPrompts(c.prompts || []),
    skills:   buildSkills(c.skills || []),
    tips:     buildTips(c.tips || []),
    hourly,
    heatmap:  buildHeatmap(c.sessionsRaw || []),
    burn:     buildBurn(hourly, totals.week),
    plan:     c.planResp || { plan: "max" },
    limits:   c.limitsResp || null,
    budget:   c.budgetResp || null,
    phase:    c.phaseResp || null,
    tags:     Array.isArray(c.tagsResp) ? c.tagsResp : [],
    prefs:    c.prefsResp || null,
  };
}

async function loadAll(range) {
  if (range !== undefined && RANGE_DAYS[range] !== undefined) currentRange = range;
  const r = currentRange;
  await _fetchKeys(REG.map((e) => e.key), _ctx(r));
  _rebuildMockData(r);
}

async function loadDelta(hint) {
  const r = currentRange;
  const ctx = _ctx(r);
  const keys = pickEntries(REG, hint || {}, ctx.rangeSince);
  if (keys.length === 0) return;          // nothing in our view changed
  await _fetchKeys(keys, ctx);
  _rebuildMockData(r);
}

async function loadStatic() {
  const r = currentRange;
  const ctx = _ctx(r);
  await _fetchKeys(pickStaticEntries(REG), ctx);
  _rebuildMockData(r);
}

const buildTotals = (r, all, m30, w7, today, yday, range) => {
  const cacheRead = w7.cache_read_tokens || 0;
  const billable7 = billable(w7);
  const cacheHit = cacheRead + billable7 > 0 ? cacheRead / (cacheRead + billable7) : 0;
  return {
    cost: all.cost_usd || 0,
    today: today.cost_usd || 0,
    yesterday: yday.cost_usd || 0,
    week: w7.cost_usd || 0,
    month: m30.cost_usd || 0,
    range: range.cost_usd || 0,
    rangeKey: r,
    rangeLabel: RANGE_LABELS[r] || r,
    rangeSessions: range.sessions || 0,
    todayTokens: totalTokens(today),
    yesterdayTokens: totalTokens(yday),
    weekTokens: totalTokens(w7),
    rangeTokens: totalTokens(range),
    allTokens: totalTokens(all),
    inputTokens: all.input_tokens || 0,
    outputTokens: all.output_tokens || 0,
    cacheReadTokens: all.cache_read_tokens || 0,
    cacheWriteTokens: (all.cache_create_5m_tokens || 0) + (all.cache_create_1h_tokens || 0),
    sessions: m30.sessions || 0,
    turns: all.turns || 0,
    avgTurnsPerSession: all.sessions ? (all.turns / all.sessions) : 0,
    cacheHitRate: cacheHit,
  };
};

const buildDaily = (daily, rangeCost) => {
  const totalBillable = daily.reduce((a, d) =>
    a + (d.input_tokens || 0) + (d.output_tokens || 0) + (d.cache_create_tokens || 0), 0) || 1;
  return daily.map((d) => {
    const b = (d.input_tokens || 0) + (d.output_tokens || 0) + (d.cache_create_tokens || 0);
    return {
      date: shortDate(d.day),
      cost: rangeCost * (b / totalBillable),
      input: d.input_tokens || 0,
      output: d.output_tokens || 0,
      cacheRead: d.cache_read_tokens || 0,
    };
  });
};

const buildProjects = (projects, rangeCost) => {
  const allBillable = projects.reduce((a, x) => a + (x.billable_tokens || 0), 0) || 1;
  return projects.map((p) => ({
    slug: p.project_slug,
    name: p.project_name || p.project_slug,
    cost: rangeCost * ((p.billable_tokens || 0) / allBillable),
    sessions: p.sessions || 0,
    tokens: (p.input_tokens || 0) + (p.output_tokens || 0),
    lastActive: "—",
  }));
};

const buildModels = (byModel) => {
  const totalBillable = byModel.reduce((a, m) => a + billable(m), 0) || 1;
  return byModel.map((m) => ({
    name: m.model,
    short: shortModel(m.model),
    cost: m.cost_usd || 0,
    share: billable(m) / totalBillable,
    tokens: billable(m),
  })).sort((a, b) => b.cost - a.cost);
};

const buildSessions = (rows) => rows.map((s) => ({
  id: s.session_id ? s.session_id.slice(0, 8) : "—",
  fullId: s.session_id || "",
  project: s.project_name || s.project_slug || "—",
  started: fmtTime(s.started),
  turns: s.turns || 0,
  tokens: s.tokens || 0,
  cost: s.cost_usd || 0,
  model: shortModel(s.model),
  firstPrompt: (s.first_prompt || "").replace(/\s+/g, " ").trim(),
  tags: Array.isArray(s.tags) ? s.tags : [],
  _raw: s,
}));

const buildPrompts = (prompts) => prompts.map((p) => ({
  id: p.user_uuid || Math.random().toString(36).slice(2),
  project: p.project_slug || "—",
  session: p.session_id ? p.session_id.slice(0, 8) : "—",
  time: relTime(p.timestamp),
  model: shortModel(p.model),
  tokens: p.billable_tokens || 0,
  cost: p.estimated_cost_usd || 0,
  preview: (p.prompt_text || "").slice(0, 240).replace(/\s+/g, " "),
}));

const buildSkills = (skills) => skills.map((s) => ({
  name: s.skill,
  invocations: s.invocations || 0,
  tokens: (s.invocations || 0) * (s.tokens_per_call || 0),
  cost: 0,
}));

const buildTips = (tips) => (Array.isArray(tips) ? tips : []).map((t) => ({
  type: t.severity || t.type || "info",
  title: t.title || t.key || "Tip",
  body: t.body || t.message || "",
  project_slug: t.project_slug || null,
  project_cwd: t.project_cwd || null,
  category: t.category || null,
  target: t.target || null,
  count: t.count || 0,
  sessions: t.sessions || 0,
}));

const buildHourly = (hourlyRaw) => Array.from({ length: 24 }, (_, i) => {
  const b = (Array.isArray(hourlyRaw) && hourlyRaw[i]) || null;
  return b ? (b.cost_usd || 0) : 0;
});

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_MS = 86400 * 7 * 1000;

const buildHeatmap = (sessionsRaw) => {
  const heatmap = WEEKDAYS.map((day) => ({ day, cells: Array.from({ length: 24 }, () => 0) }));
  sessionsRaw.forEach((s) => {
    if (!s.started) return;
    const d = new Date(s.started);
    const ageMs = Date.now() - d.getTime();
    if (ageMs < 0 || ageMs > WEEK_MS) return;
    const dayIdx = (d.getDay() + 6) % 7;
    heatmap[dayIdx].cells[d.getHours()] += s.turns || 0;
  });
  return heatmap;
};

const buildBurn = (hourly, weekCost) => {
  const lastHour = hourly[hourly.length - 1] || 0;
  const weeklyAvg = (weekCost / 7 / 24) || 0;
  return {
    rate: lastHour,
    weeklyAvg,
    multiple: weeklyAvg > 0 ? lastHour / weeklyAvg : 0,
  };
};

const EMPTY_DATA = () => ({
  totals: {}, daily: [], projects: [], models: [], tools: [],
  sessions: [], prompts: [], skills: [], tips: [],
  hourly: Array(24).fill(0),
  heatmap: WEEKDAYS.map((d) => ({ day: d, cells: Array(24).fill(0) })),
  burn: { rate: 0, weeklyAvg: 0, multiple: 0 },
  plan: { plan: "max" },
  limits: null,
  budget: null,
  phase: null,
  tags: [],
  prefs: null,
});

window.DATA_READY = loadAll().catch((err) => {
  console.error("data load failed", err);
  window.MOCK_DATA = window.MOCK_DATA || EMPTY_DATA();
});

window.RELOAD_DATA   = loadAll;     // back-compat alias
window.RELOAD_DELTA  = loadDelta;
window.RELOAD_STATIC = loadStatic;
