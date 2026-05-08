// Real-data adapter for Direction A.
// Fetches existing /api/* endpoints and shapes them into the MOCK_DATA contract
// the React component expects. Mounted by index.html after `window.DATA_READY` resolves.

(function () {
  const fmtTokens = (n) => (n || 0);

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

  let currentRange = "30d";

  async function load(range) {
    if (range !== undefined && RANGE_DAYS[range] !== undefined) currentRange = range;
    const r = currentRange;
    const days = RANGE_DAYS[r];
    const rangeSince = days == null ? null : isoDaysAgo(days);
    const rq = (extra) => rangeSince ? `?since=${encodeURIComponent(rangeSince)}${extra ? "&" + extra : ""}` : (extra ? `?${extra}` : "");

    const since30 = isoDaysAgo(30);
    const since7 = isoDaysAgo(7);
    const since1 = isoDaysAgo(1);

    const [
      overviewAll, overview30, overview7, overviewToday, overviewYday,
      overviewRange,
      daily, projects, tools, sessionsRaw, skills, byModel, prompts, hourlyRaw, tips, planResp,
    ] = await Promise.all([
      j("/api/overview"),
      j(`/api/overview?since=${encodeURIComponent(since30)}`),
      j(`/api/overview?since=${encodeURIComponent(since7)}`),
      j(`/api/overview?since=${encodeURIComponent(isoDaysAgo(0))}`),
      j(`/api/overview?since=${encodeURIComponent(since1)}&until=${encodeURIComponent(isoDaysAgo(0))}`),
      j(`/api/overview${rq("")}`),
      j(`/api/daily${rq("")}`),
      j(`/api/projects${rq("")}`),
      j(`/api/tools${rq("")}`),
      j(`/api/sessions${rq("limit=50")}`),
      j(`/api/skills${rq("")}`),
      j(`/api/by-model${rq("")}`),
      j(`/api/prompts${rq("limit=20&sort=tokens")}`),
      j("/api/hourly?hours=24").catch(() => []),
      j("/api/tips").catch(() => []),
      j("/api/plan").catch(() => ({ plan: "max" })),
    ]);

    const totalCost = overviewAll.cost_usd || 0;
    const monthCost = overview30.cost_usd || 0;
    const weekCost = overview7.cost_usd || 0;
    const todayCost = overviewToday.cost_usd || 0;
    const ydayCost = overviewYday.cost_usd || 0;
    const rangeCost = overviewRange.cost_usd || 0;
    const cacheRead = overview7.cache_read_tokens || 0;
    const billable = (o) => (o.input_tokens || 0) + (o.output_tokens || 0)
      + (o.cache_create_5m_tokens || 0) + (o.cache_create_1h_tokens || 0);
    const totalTokens = (o) => billable(o) + (o.cache_read_tokens || 0);
    const billable7 = billable(overview7);
    const cacheHit = cacheRead + billable7 > 0 ? cacheRead / (cacheRead + billable7) : 0;

    const RANGE_LABELS = { "1d": "1 day", "7d": "7 days", "30d": "30 days", "90d": "90 days", "all": "all-time" };
    const totals = {
      cost: totalCost,
      today: todayCost,
      yesterday: ydayCost,
      week: weekCost,
      month: monthCost,
      range: rangeCost,
      rangeKey: r,
      rangeLabel: RANGE_LABELS[r] || r,
      rangeSessions: overviewRange.sessions || 0,
      todayTokens: totalTokens(overviewToday),
      yesterdayTokens: totalTokens(overviewYday),
      weekTokens: totalTokens(overview7),
      rangeTokens: totalTokens(overviewRange),
      allTokens: totalTokens(overviewAll),
      inputTokens: overviewAll.input_tokens || 0,
      outputTokens: overviewAll.output_tokens || 0,
      cacheReadTokens: overviewAll.cache_read_tokens || 0,
      cacheWriteTokens: (overviewAll.cache_create_5m_tokens || 0) + (overviewAll.cache_create_1h_tokens || 0),
      sessions: overview30.sessions || 0,
      turns: overviewAll.turns || 0,
      avgTurnsPerSession: overviewAll.sessions ? (overviewAll.turns / overviewAll.sessions) : 0,
      cacheHitRate: cacheHit,
    };

    // daily — map db rows; cost approximated proportionally to billable token totals if no per-day cost API
    const totalBillable = daily.reduce((a, d) => a + (d.input_tokens || 0) + (d.output_tokens || 0)
      + (d.cache_create_tokens || 0), 0) || 1;
    const dailyMapped = daily.map((d) => {
      const billable = (d.input_tokens || 0) + (d.output_tokens || 0) + (d.cache_create_tokens || 0);
      return {
        date: shortDate(d.day),
        cost: rangeCost * (billable / totalBillable),
        input: d.input_tokens || 0,
        output: d.output_tokens || 0,
        cacheRead: d.cache_read_tokens || 0,
      };
    });

    // projects
    const projectsMapped = projects.map((p) => {
      const tokens = (p.input_tokens || 0) + (p.output_tokens || 0);
      // project cost not returned; approximate share of total all-time cost
      const allBillable = projects.reduce((a, x) => a + (x.billable_tokens || 0), 0) || 1;
      const cost = rangeCost * ((p.billable_tokens || 0) / allBillable);
      return {
        slug: p.project_slug,
        name: p.project_name || p.project_slug,
        cost: cost,
        sessions: p.sessions || 0,
        tokens: tokens,
        lastActive: "—",
      };
    });

    // models
    const modelTotalBillable = byModel.reduce((a, m) => a + (m.input_tokens || 0) + (m.output_tokens || 0)
      + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0), 0) || 1;
    const modelTotalCost = byModel.reduce((a, m) => a + (m.cost_usd || 0), 0) || 1;
    const modelsMapped = byModel.map((m) => {
      const billable = (m.input_tokens || 0) + (m.output_tokens || 0)
        + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0);
      return {
        name: m.model,
        short: shortModel(m.model),
        cost: m.cost_usd || 0,
        share: billable / modelTotalBillable,
        tokens: billable,
      };
    }).sort((a, b) => b.cost - a.cost);

    // tools
    const toolsMapped = tools.map((t) => ({
      name: t.tool_name,
      calls: t.calls || 0,
      tokens: t.result_tokens || 0,
    }));

    // sessions
    const sessionsMapped = sessionsRaw.map((s) => ({
      id: s.session_id ? s.session_id.slice(0, 8) : "—",
      fullId: s.session_id || "",
      project: s.project_name || s.project_slug || "—",
      started: fmtTime(s.started),
      turns: s.turns || 0,
      tokens: s.tokens || 0,
      cost: s.cost_usd || 0,
      model: shortModel(s.model),
      firstPrompt: (s.first_prompt || "").replace(/\s+/g, " ").trim(),
      _raw: s,
    }));

    // prompts
    const promptsMapped = prompts.map((p) => ({
      id: p.user_uuid || Math.random().toString(36).slice(2),
      project: p.project_slug || "—",
      session: p.session_id ? p.session_id.slice(0, 8) : "—",
      time: relTime(p.timestamp),
      model: shortModel(p.model),
      tokens: p.billable_tokens || 0,
      cost: p.estimated_cost_usd || 0,
      preview: (p.prompt_text || "").slice(0, 240).replace(/\s+/g, " "),
    }));

    // skills
    const skillsMapped = skills.map((s) => ({
      name: s.skill,
      invocations: s.invocations || 0,
      tokens: (s.invocations || 0) * (s.tokens_per_call || 0),
      cost: 0,
    }));

    // tips
    const tipsMapped = (Array.isArray(tips) ? tips : []).map((t) => ({
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

    // hourly — last 24h cost per hour, from /api/hourly (DB-backed, oldest→newest).
    const hourly = Array.from({ length: 24 }, (_, i) => {
      const b = (Array.isArray(hourlyRaw) && hourlyRaw[i]) || null;
      return b ? (b.cost_usd || 0) : 0;
    });

    // heatmap — turns per hour, last 7 days × 24h, bucketed from sessions.
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const heatmap = weekdays.map((day) => ({ day, cells: Array.from({ length: 24 }, () => 0) }));
    sessionsRaw.forEach((s) => {
      if (!s.started) return;
      const d = new Date(s.started);
      const ageMs = Date.now() - d.getTime();
      if (ageMs < 0 || ageMs > 86400 * 7 * 1000) return;
      const dayIdx = (d.getDay() + 6) % 7;
      const h = d.getHours();
      heatmap[dayIdx].cells[h] += s.turns || 0;
    });

    // burn — last hour vs weekly avg
    const lastHour = hourly[hourly.length - 1] || 0;
    const weeklyAvg = (weekCost / 7 / 24) || 0;
    const burn = {
      rate: lastHour,
      weeklyAvg: weeklyAvg,
      multiple: weeklyAvg > 0 ? lastHour / weeklyAvg : 0,
    };

    window.MOCK_DATA = {
      totals,
      daily: dailyMapped,
      projects: projectsMapped,
      models: modelsMapped,
      tools: toolsMapped,
      sessions: sessionsMapped,
      prompts: promptsMapped,
      skills: skillsMapped,
      tips: tipsMapped,
      hourly,
      heatmap,
      burn,
      plan: planResp || { plan: "max" },
    };
  }

  // expose loader; index.html awaits this before mounting React
  window.DATA_READY = load().catch((err) => {
    console.error("data load failed", err);
    window.MOCK_DATA = window.MOCK_DATA || {
      totals: {}, daily: [], projects: [], models: [], tools: [],
      sessions: [], prompts: [], skills: [], tips: [],
      hourly: Array(24).fill(0),
      heatmap: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => ({ day: d, cells: Array(24).fill(0) })),
      burn: { rate: 0, weeklyAvg: 0, multiple: 0 },
      plan: { plan: "max" },
    };
  });

  window.RELOAD_DATA = load;
})();
