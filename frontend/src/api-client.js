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
const RANGE_LABELS = { "1d": "1 day", "7d": "7 days", "30d": "30 days", "90d": "90 days", "all": "all-time", "custom": "custom" };
const RANGE_PLUS = { "1d": "7d", "7d": "30d", "30d": "90d", "90d": "all", "all": "all" };

// Build the `?since=&until=` query suffix for a range that may be either a
// preset (since-only) or "custom" (since + until from the user-picked dates).
const rangeQuery = (rangeSince, rangeUntil) => {
  const parts = [];
  if (rangeSince) parts.push(`since=${encodeURIComponent(rangeSince)}`);
  if (rangeUntil) parts.push(`until=${encodeURIComponent(rangeUntil)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const _plusKey = () => RANGE_PLUS[currentRange] || "all";
const _plusSince = () => {
  const days = RANGE_DAYS[_plusKey()];
  return days == null ? null : isoDaysAgo(days);
};

const billable = (o) => (o.input_tokens || 0) + (o.output_tokens || 0)
  + (o.cache_create_5m_tokens || 0) + (o.cache_create_1h_tokens || 0);

const totalTokens = (o) => billable(o) + (o.cache_read_tokens || 0);

let currentRange = "30d";
let currentPromptQuery = "";
let currentProvider = "all";
let _customSince = null;
let _customUntil = null;

// Append `provider=` to an existing URL (which may or may not already have
// a query string). "all" / falsy = no-op since the backend treats absence
// as "no filter".
const withProvider = (url) => {
  if (!currentProvider || currentProvider === "all") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}provider=${encodeURIComponent(currentProvider)}`;
};

// Endpoint registry. Each entry declares:
//   key       — slot in MOCK_DATA the result lands in
//   url(ctx)  — URL builder, given { rangeSince, range }
//   trigger   — "any" | "static" | "sessions" | "projects" | "models" | "days"
//   windowSince(range) — only for ["days"]; returns ISO since-bound or null
//   fallback() — only for endpoints that may legitimately 404 / error; called on fetch failure
//
// loadAll runs every entry. (Tasks 4–5 add loadDelta + loadStatic.)
const REG = [
  { key: "overviewAll",   trigger: "any",   url: () => withProvider("/api/overview") },
  { key: "overview30",    trigger: "days",  windowSince: () => isoDaysAgo(30), url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(30))}`) },
  { key: "overview7",     trigger: "days",  windowSince: () => isoDaysAgo(7),  url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(7))}`) },
  { key: "overviewToday", trigger: "days",  windowSince: () => isoDaysAgo(0),  url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(0))}`) },
  { key: "overviewYday",  trigger: "days",  windowSince: () => isoDaysAgo(1),  url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(1))}&until=${encodeURIComponent(isoDaysAgo(0))}`) },
  { key: "overviewRange", trigger: "days",  windowSince: (r) => r, url: ({ rangeSince, rangeUntil }) => withProvider(`/api/overview${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "overviewPlus",  trigger: "days",  windowSince: () => _plusSince(), url: ({ plusSince }) => withProvider(`/api/overview${plusSince ? `?since=${encodeURIComponent(plusSince)}` : ""}`) },
  { key: "daily",         trigger: "days",  windowSince: (r) => r, url: ({ rangeSince, rangeUntil }) => withProvider(`/api/daily${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "dailyPlus",     trigger: "days",  windowSince: () => _plusSince(), url: ({ plusSince }) => withProvider(`/api/daily${plusSince ? `?since=${encodeURIComponent(plusSince)}` : ""}`) },
  { key: "projects",      trigger: "projects", url: ({ rangeSince, rangeUntil }) => withProvider(`/api/projects${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "tools",         trigger: "any",   url: ({ rangeSince, rangeUntil }) => withProvider(`/api/tools${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "sessionsRaw",   trigger: "sessions", url: ({ rangeSince, rangeUntil }) => withProvider(`/api/sessions${rangeQuery(rangeSince, rangeUntil)}${rangeQuery(rangeSince, rangeUntil) ? "&" : "?"}limit=50`) },
  { key: "topSessionsRaw", trigger: "sessions", url: () => withProvider(`/api/sessions?order=cost&limit=50`), fallback: () => [] },
  { key: "skills",        trigger: "any",   url: ({ rangeSince, rangeUntil }) => withProvider(`/api/skills${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "byModel",       trigger: "models", url: ({ rangeSince, rangeUntil }) => withProvider(`/api/by-model${rangeQuery(rangeSince, rangeUntil)}`) },
  { key: "cacheStats",    trigger: "days",  url: () => "/api/cache-stats?days=30", fallback: () => ({ days: [], avg_7d: 0, avg_30d: 0 }) },
  { key: "burnRate",      trigger: "days",  url: () => "/api/burn-rate?window_days=7", fallback: () => null },
  { key: "prompts",       trigger: "sessions", url: ({ rangeSince, rangeUntil, promptQuery }) => {
      const parts = [];
      if (rangeSince) parts.push(`since=${encodeURIComponent(rangeSince)}`);
      if (rangeUntil) parts.push(`until=${encodeURIComponent(rangeUntil)}`);
      if (promptQuery) parts.push(`q=${encodeURIComponent(promptQuery)}`);
      parts.push("limit=50", "sort=tokens");
      return withProvider(`/api/prompts?${parts.join("&")}`);
    } },
  { key: "hourlyRaw",     trigger: "days",  windowSince: () => isoDaysAgo(1), url: () => withProvider("/api/hourly?hours=24"), fallback: () => [] },
  { key: "recentPromptsRaw", trigger: "sessions", url: () => withProvider("/api/prompts?sort=recent&limit=5"), fallback: () => [] },
  { key: "prevWeekOv",    trigger: "days",  windowSince: () => isoDaysAgo(14), url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(14))}&until=${encodeURIComponent(isoDaysAgo(7))}`), fallback: () => ({}) },
  { key: "prevMonthOv",   trigger: "days",  windowSince: () => isoDaysAgo(60), url: () => withProvider(`/api/overview?since=${encodeURIComponent(isoDaysAgo(60))}&until=${encodeURIComponent(isoDaysAgo(30))}`), fallback: () => ({}) },
  { key: "skillsToday",   trigger: "days",  windowSince: () => isoDaysAgo(0), url: () => withProvider(`/api/skills?since=${encodeURIComponent(isoDaysAgo(0))}`), fallback: () => [] },
  { key: "tips",          trigger: "any",   url: () => "/api/tips", fallback: () => [] },
  { key: "planResp",      trigger: "static", url: () => "/api/plan",   fallback: () => ({ plan: "max" }) },
  { key: "limitsResp",    trigger: "static", url: () => "/api/limits", fallback: () => null },
  { key: "budgetResp",    trigger: "static", url: () => "/api/budget", fallback: () => null },
  { key: "budgetAlerts",  trigger: "any",    url: () => "/api/budget-alerts", fallback: () => null },
  { key: "phaseResp",     trigger: "any",   url: ({ rangeSince, rangeUntil }) => withProvider(`/api/phase-split${rangeQuery(rangeSince, rangeUntil)}`), fallback: () => null },
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
  const isCustom = range === "custom";
  const days = RANGE_DAYS[range];
  const pk = isCustom ? "all" : (RANGE_PLUS[range] || "all");
  const pdays = RANGE_DAYS[pk];
  const rangeSince = isCustom ? (_customSince || null) : (days == null ? null : isoDaysAgo(days));
  return {
    range,
    rangeSince,
    rangeUntil: isCustom ? (_customUntil || null) : null,
    plusKey: pk,
    plusSince: pdays == null ? null : isoDaysAgo(pdays),
    promptQuery: currentPromptQuery || null,
  };
}

function _rebuildMockData(range) {
  const c = _cache;
  const plusKey = RANGE_PLUS[range] || "all";
  const totals = buildTotals(range, c.overviewAll || {}, c.overview30 || {}, c.overview7 || {}, c.overviewToday || {}, c.overviewYday || {}, c.overviewRange || {}, c.overviewPlus || {}, plusKey);
  const hourly = buildHourly(c.hourlyRaw || []);
  window.MOCK_DATA = {
    totals,
    daily:    buildDaily(c.daily || [], totals.range),
    dailyPlus: buildDaily(c.dailyPlus || [], totals.plusCost || 0),
    projects: buildProjects(c.projects || [], totals.range),
    models:   buildModels(c.byModel || []),
    tools:    (c.tools || []).map((t) => ({ name: t.tool_name, calls: t.calls || 0, tokens: t.result_tokens || 0 })),
    sessions: buildSessions(c.sessionsRaw || []),
    topSessions: buildSessions(c.topSessionsRaw || []),
    prompts:  buildPrompts(c.prompts || []),
    skills:   buildSkills(c.skills || []),
    tips:     buildTips(c.tips || []),
    hourly,
    hourlyDetail: buildHourlyDetail(c.hourlyRaw || []),
    heatmap:  buildHeatmap(c.sessionsRaw || []),
    burn:     buildBurn(hourly, totals.week),
    today:    buildToday(c.overviewToday || {}),
    plan:     c.planResp || { plan: "max" },
    limits:   c.limitsResp || null,
    budget:   c.budgetResp || null,
    phase:    c.phaseResp || null,
    tags:     Array.isArray(c.tagsResp) ? c.tagsResp : [],
    prefs:    c.prefsResp || null,
    lastPrompt:    buildLastPrompt(c.recentPromptsRaw || []),
    promptsToday:  buildPromptsToday(c.overviewToday || {}),
    activeSession: buildActiveSession(c.sessionsRaw || []),
    idleSince:     buildIdleSince(c.sessionsRaw || [], c.recentPromptsRaw || []),
    skillOfDay:    buildSkillOfDay(c.skillsToday || []),
    wow:           buildDeltaPair(c.overview7 || {}, c.prevWeekOv || {}),
    mom:           buildDeltaPair(c.overview30 || {}, c.prevMonthOv || {}),
    peakHour:      buildPeakHour(c.hourlyRaw || []),
    cacheStats:    c.cacheStats || { days: [], avg_7d: 0, avg_30d: 0 },
    burnRate:      c.burnRate || null,
    budgetAlerts:  c.budgetAlerts || null,
  };
  // Notify subscribers that MOCK_DATA was mutated. React components read
  // through a Proxy so they need an external nudge to re-render after
  // SSE-driven refreshes (range-driven loads bump their own state).
  try { window.dispatchEvent(new CustomEvent("td:data")); } catch (_) {}
}

async function loadAll(range) {
  if (range !== undefined && (RANGE_DAYS[range] !== undefined || range === "custom")) {
    currentRange = range;
  }
  const r = currentRange;
  await _fetchKeys(REG.map((e) => e.key), _ctx(r));
  _rebuildMockData(r);
}

async function setCustomRange(since, until) {
  _customSince = since || null;
  _customUntil = until || null;
  if (_customSince || _customUntil) {
    await loadAll("custom");
  }
}

async function setPromptQuery(q) {
  currentPromptQuery = (q || "").trim();
  // Only the prompts endpoint depends on the query; refetch just that slice.
  await _fetchKeys(["prompts"], _ctx(currentRange));
  _rebuildMockData(currentRange);
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

const buildTotals = (r, all, m30, w7, today, yday, range, plus, plusKey) => {
  const cacheReadRange = range.cache_read_tokens || 0;
  const billableRange = billable(range);
  const cacheHit = cacheReadRange + billableRange > 0
    ? cacheReadRange / (cacheReadRange + billableRange)
    : 0;
  const plusObj = plus || {};
  return {
    plusKey,
    plusLabel: RANGE_LABELS[plusKey] || plusKey,
    plusCost: plusObj.cost_usd || 0,
    plusTokens: totalTokens(plusObj),
    plusSessions: plusObj.sessions || 0,
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
    inputTokens: range.input_tokens || 0,
    outputTokens: range.output_tokens || 0,
    cacheReadTokens: range.cache_read_tokens || 0,
    cacheWriteTokens: (range.cache_create_5m_tokens || 0) + (range.cache_create_1h_tokens || 0),
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
    lastActive: p.last_active || null,
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
  sessions: s.sessions || 0,
  tokensPerCall: s.tokens_per_call,
  tokens: s.est_tokens != null ? s.est_tokens : null,
  cost: s.est_cost_usd != null ? s.est_cost_usd : null,
  estimated: s.estimated === true,
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

const buildHourlyDetail = (hourlyRaw) => {
  const now = new Date();
  return Array.from({ length: 24 }, (_, i) => {
    const b = (Array.isArray(hourlyRaw) && hourlyRaw[i]) || null;
    const ts = new Date(now.getTime() - (23 - i) * 3600 * 1000);
    const hh = String(ts.getHours()).padStart(2, "0");
    return {
      date: `${hh}:00`,
      cost: b ? (b.cost_usd || 0) : 0,
      input: b ? (b.input_tokens || 0) : 0,
      output: b ? (b.output_tokens || 0) : 0,
      cacheRead: b ? (b.cache_read_tokens || 0) : 0,
    };
  });
};

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

const buildToday = (today) => {
  const input = today.input_tokens || 0;
  const output = today.output_tokens || 0;
  const cacheRead = today.cache_read_tokens || 0;
  const cacheWrite = (today.cache_create_5m_tokens || 0) + (today.cache_create_1h_tokens || 0);
  const billableTok = input + output + cacheWrite;
  const cacheHitRate = (cacheRead + billableTok) > 0
    ? cacheRead / (cacheRead + billableTok)
    : 0;
  return {
    cost: today.cost_usd || 0,
    tokens: input + output + cacheRead + cacheWrite,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheHitRate,
    sessions: today.sessions || 0,
  };
};

const buildLastPrompt = (rows) => {
  const r = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!r) return null;
  return {
    cost: r.estimated_cost_usd || 0,
    tokens: r.billable_tokens || 0,
    model: shortModel(r.model),
    timestamp: r.timestamp || null,
    project: r.project_slug || null,
  };
};

const buildPromptsToday = (today) => {
  const count = today.turns || 0;
  const cost = today.cost_usd || 0;
  return { count, avgCost: count > 0 ? cost / count : 0, totalCost: cost };
};

const buildActiveSession = (rows) => {
  const r = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!r || !r.started) return null;
  const started = new Date(r.started).getTime();
  const ended = r.ended ? new Date(r.ended).getTime() : started;
  return {
    id: r.session_id || null,
    project: r.project_name || r.project_slug || "—",
    cost: r.cost_usd || 0,
    tokens: r.tokens || 0,
    started: r.started,
    ended: r.ended || r.started,
    durationMs: Math.max(0, ended - started),
    idleMs: Math.max(0, Date.now() - ended),
  };
};

const buildIdleSince = (sessions, prompts) => {
  const candidates = [];
  if (sessions[0] && sessions[0].ended) candidates.push(new Date(sessions[0].ended).getTime());
  if (prompts[0] && prompts[0].timestamp) candidates.push(new Date(prompts[0].timestamp).getTime());
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates)).toISOString();
};

const buildSkillOfDay = (skills) => {
  if (!Array.isArray(skills) || skills.length === 0) return null;
  const top = skills.slice().sort((a, b) => (b.invocations || 0) - (a.invocations || 0))[0];
  if (!top || !top.invocations) return null;
  return {
    name: top.skill,
    invocations: top.invocations || 0,
    sessions: top.sessions || 0,
  };
};

const buildDeltaPair = (current, previous) => {
  const cur = current.cost_usd || 0;
  const prev = previous.cost_usd || 0;
  const delta = cur - prev;
  const pct = prev > 0 ? delta / prev : (cur > 0 ? 1 : 0);
  return { current: cur, previous: prev, delta, pct };
};

const buildPeakHour = (hourlyRaw) => {
  const arr = Array.isArray(hourlyRaw) ? hourlyRaw : [];
  if (arr.length === 0) return null;
  let bestIdx = -1;
  let bestCost = -1;
  arr.forEach((b, i) => {
    const c = (b && b.cost_usd) || 0;
    if (c > bestCost) { bestCost = c; bestIdx = i; }
  });
  if (bestIdx < 0 || bestCost <= 0) return null;
  // hourlyRaw is oldest→newest over the last 24h; convert idx to clock hour.
  const now = new Date();
  const ts = new Date(now.getTime() - (arr.length - 1 - bestIdx) * 3600 * 1000);
  return { hour: ts.getHours(), cost: bestCost };
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
window.SET_CUSTOM_RANGE = setCustomRange;
window.SET_PROMPT_QUERY = setPromptQuery;
// Provider filter — currentProvider is read lazily by withProvider()
// inside the REG entries, so caller doesn't need to refetch here. The
// next loadAll/loadDelta picks up the new value. App.jsx calls this
// just before RELOAD_DATA on every provider change.
window.SET_PROVIDER = (p) => { currentProvider = p || "all"; };

// /api/stream consumer.
//
// In the 3.x Electron build the main process held the SSE connection
// and forwarded ticks to the renderer. The Tauri shell has no main-
// process bridge — the webview talks directly to the embedded server,
// so we run the SSE loop in the page itself.
//
// Plan §R1 trip wire: webkit2gtk has a documented history of dropping
// idle SSE connections. If the first attempt produces no frames within
// 90s, or three consecutive reconnects fail, we fall back to a 15s
// polling loop. The fallback never reverts to SSE in the same page
// session — a manual reload is the recovery path. That trade-off
// avoids flapping in the wild.
const SSE_RECONNECT_BASE_MS = 1000;
const SSE_RECONNECT_MAX_MS = 5000;
const SSE_FIRST_FRAME_TIMEOUT_MS = 90_000;
const POLL_FALLBACK_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

let _streamSource = null;
let _firstFrameTimer = null;
let _consecutiveFailures = 0;
let _pollingFallbackTimer = null;
let _freshTimer = null;

// Brand-dot freshness signal. Toggles documentElement[data-fresh] for 30s
// after a scan lands. CSS gates the brand pulse on this attribute — flat
// when stale, subtle pulse when fresh. The only motion in the system that
// communicates state, so it earns its keep.
const FRESH_WINDOW_MS = 30_000;
function _markFresh() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.fresh = "1";
  if (_freshTimer) clearTimeout(_freshTimer);
  _freshTimer = setTimeout(() => {
    delete document.documentElement.dataset.fresh;
    _freshTimer = null;
  }, FRESH_WINDOW_MS);
}

function _onPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const type = payload.type;
  // Map known events back to the existing loadDelta/loadStatic surface.
  switch (type) {
    case "scan_complete":
      // Fresh transcripts → everything in the dashboard view may have moved.
      _markFresh();
      // Pass the full payload (sessions/projects/days/models hints) so
      // pickEntries can route the refetch to the right registry slots —
      // notably the "days"-triggered overviewToday/overviewYday/daily/
      // hourlyRaw set, which would otherwise never refresh after init.
      loadDelta(payload).catch((e) => console.warn("loadDelta scan", e));
      break;
    case "preferences":
    case "plan":
    case "sources":
    case "tags":
    case "limits_refreshed":
      loadStatic().catch((e) => console.warn("loadStatic", e));
      break;
    default:
      // Unknown event types are forward-compatible no-ops.
      break;
  }
}

function _connectStream() {
  if (typeof EventSource !== "function") {
    _activatePollingFallback("EventSource unsupported");
    return;
  }
  try {
    _streamSource = new EventSource("/api/stream");
  } catch (err) {
    console.warn("SSE construct failed", err);
    _scheduleReconnectOrFallback();
    return;
  }

  // First-frame watchdog: if the connection opens but never delivers
  // an event in the first 90s, treat it as a wedged connection (the
  // webkit2gtk failure mode plan §R1 calls out).
  if (_firstFrameTimer) clearTimeout(_firstFrameTimer);
  _firstFrameTimer = setTimeout(() => {
    console.warn("SSE: no frames in first 90s, falling back to polling");
    _activatePollingFallback("no-frames");
  }, SSE_FIRST_FRAME_TIMEOUT_MS);

  const cancelWatchdog = () => {
    if (_firstFrameTimer) {
      clearTimeout(_firstFrameTimer);
      _firstFrameTimer = null;
    }
  };

  _streamSource.addEventListener("hello", () => {
    cancelWatchdog();
    _consecutiveFailures = 0;
  });
  // Real events. Tauri shell's bus emits typed events; the EventSource
  // default `message` channel only receives events without a `type`
  // field, so we listen to specific names.
  ["scan_complete", "preferences", "plan", "sources", "tags", "limits_refreshed", "lagged"].forEach(
    (name) => {
      _streamSource.addEventListener(name, (ev) => {
        cancelWatchdog();
        _consecutiveFailures = 0;
        let payload = null;
        try { payload = JSON.parse(ev.data || "{}"); } catch (_) {}
        if (name === "lagged") {
          // Server told us the listener fell behind — refetch everything.
          loadAll().catch((e) => console.warn("loadAll lagged", e));
          return;
        }
        _onPayload(Object.assign({ type: name }, payload || {}));
      });
    },
  );
  _streamSource.addEventListener("error", () => {
    cancelWatchdog();
    if (_streamSource) {
      try { _streamSource.close(); } catch (_) {}
      _streamSource = null;
    }
    _consecutiveFailures += 1;
    _scheduleReconnectOrFallback();
  });
}

function _scheduleReconnectOrFallback() {
  if (_pollingFallbackTimer) return; // already in fallback mode
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    _activatePollingFallback(`${_consecutiveFailures} consecutive failures`);
    return;
  }
  const delay = Math.min(
    SSE_RECONNECT_BASE_MS * Math.pow(2, _consecutiveFailures - 1),
    SSE_RECONNECT_MAX_MS,
  );
  setTimeout(_connectStream, delay);
}

function _activatePollingFallback(reason) {
  if (_pollingFallbackTimer) return;
  console.warn(`SSE polling fallback active (${reason})`);
  if (_streamSource) {
    try { _streamSource.close(); } catch (_) {}
    _streamSource = null;
  }
  _pollingFallbackTimer = setInterval(() => {
    loadAll().catch((e) => console.warn("polling loadAll", e));
  }, POLL_FALLBACK_MS);
}

// Kick off the stream connection after the initial data load resolves
// — we don't want the first frame to land before the page renders.
window.DATA_READY.finally(() => _connectStream());
