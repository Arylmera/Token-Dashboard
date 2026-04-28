import { withDb } from './db.js';

function isoDaysAgo(todayIso, n) {
  const d = new Date(todayIso.replace(/Z$/, ''));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function key(category, scope) {
  return `${category}:${scope}`;
}

function isDismissed(db, k) {
  const r = db.prepare('SELECT dismissed_at FROM dismissed_tips WHERE tip_key=?').get(k);
  if (!r) return false;
  return Date.now() / 1000 - Number(r.dismissed_at) < 14 * 86400;
}

export function dismissTip(dbPath, k) {
  withDb(dbPath, (db) => {
    db.prepare('INSERT OR REPLACE INTO dismissed_tips (tip_key, dismissed_at) VALUES (?, ?)').run(
      k,
      Date.now() / 1000
    );
  });
}

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

function withTipsDb(arg, fn) {
  if (typeof arg === 'string') return withDb(arg, fn);
  return fn(arg);
}

export function cacheDisciplineTips(dbOrPath, todayIso = null) {
  const today = todayIso || new Date().toISOString();
  return withTipsDb(dbOrPath, (db) => _cacheDisciplineTips(db, today));
}

function _cacheDisciplineTips(db, todayIso) {
  const since = isoDaysAgo(todayIso, 7);
  const out = [];
  const rows = db
    .prepare(
      `SELECT project_slug,
              SUM(cache_read_tokens) AS cr,
              SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS rebuild
         FROM messages
        WHERE type='assistant' AND timestamp >= ?
        GROUP BY project_slug
        HAVING (cr + rebuild) > 100000`
    )
    .all(since);
  for (const row of rows) {
    const cr = num(row.cr);
    const rebuild = num(row.rebuild);
    const total = cr + rebuild;
    const hit = total ? cr / total : 0;
    if (hit < 0.4) {
      const k = key('cache', row.project_slug);
      if (isDismissed(db, k)) continue;
      out.push({
        key: k,
        category: 'cache',
        title: `Low cache hit rate in ${row.project_slug}`,
        body: `Cache hit rate is ${Math.round(hit * 100)}% over the last 7 days. Sessions that restart context frequently rebuild cache. Consider longer-lived sessions or fewer context resets.`,
        scope: row.project_slug,
        project_slug: row.project_slug,
      });
    }
  }
  return out;
}

export function repeatedTargetTips(dbOrPath, todayIso = null) {
  const today = todayIso || new Date().toISOString();
  return withTipsDb(dbOrPath, (db) => _repeatedTargetTips(db, today));
}

function _repeatedTargetTips(db, todayIso) {
  const since = isoDaysAgo(todayIso, 7);
  const out = [];

  const reads = db
    .prepare(
      `SELECT project_slug, target, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions
         FROM tool_calls
        WHERE tool_name IN ('Read','Edit','Write') AND timestamp >= ?
        GROUP BY project_slug, target HAVING n > 10
        ORDER BY n DESC LIMIT 10`
    )
    .all(since);
  for (const row of reads) {
    const slug = row.project_slug || '?';
    const target = row.target || '?';
    const k = key('repeat-file', `${slug}:${target}`);
    if (isDismissed(db, k)) continue;
    out.push({
      key: k, category: 'repeat-file',
      title: `${target} read ${Number(row.n)} times in ${slug}`,
      body: `This file was opened ${Number(row.n)} times across ${Number(row.sessions)} sessions in the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.`,
      scope: target, project_slug: row.project_slug,
      target, count: Number(row.n), sessions: Number(row.sessions),
    });
  }

  const bashes = db
    .prepare(
      `SELECT project_slug, target, COUNT(*) AS n
         FROM tool_calls
        WHERE tool_name='Bash' AND timestamp >= ?
        GROUP BY project_slug, target HAVING n > 15
        ORDER BY n DESC LIMIT 10`
    )
    .all(since);
  for (const row of bashes) {
    const slug = row.project_slug || '?';
    const target = row.target || '?';
    const k = key('repeat-bash', `${slug}:${target}`);
    if (isDismissed(db, k)) continue;
    out.push({
      key: k, category: 'repeat-bash',
      title: `\`${target}\` ran ${Number(row.n)} times in ${slug}`,
      body: `This bash command ran ${Number(row.n)} times in the past 7 days. Consider a watch flag or shell alias.`,
      scope: target, project_slug: row.project_slug,
      target, count: Number(row.n),
    });
  }
  return out;
}

export function rightSizeTips(dbOrPath, todayIso = null) {
  const today = todayIso || new Date().toISOString();
  return withTipsDb(dbOrPath, (db) => _rightSizeTips(db, today));
}

function _rightSizeTips(db, todayIso) {
  const since = isoDaysAgo(todayIso, 7);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(input_tokens+cache_create_5m_tokens+cache_create_1h_tokens) AS in_tok,
              SUM(output_tokens) AS out_tok
         FROM messages
        WHERE type='assistant' AND model LIKE '%opus%'
          AND output_tokens < 500 AND is_sidechain = 0
          AND timestamp >= ?`
    )
    .get(since);
  if (!row || num(row.n) < 10) return [];
  const inTok = num(row.in_tok);
  const outTok = num(row.out_tok);
  const apiOpus = (inTok * 15 + outTok * 75) / 1_000_000;
  const apiSonnet = (inTok * 3 + outTok * 15) / 1_000_000;
  const savings = apiOpus - apiSonnet;
  if (savings < 1) return [];
  const k = key('right-size', 'opus-short-turns-7d');
  if (isDismissed(db, k)) return [];
  return [{
    key: k, category: 'right-size',
    title: `${Number(row.n)} short Opus turns might fit on Sonnet`,
    body: `Opus turns under 500 output tokens cost ~$${apiOpus.toFixed(2)} in the last 7 days. Sonnet would have cost ~$${apiSonnet.toFixed(2)} (savings ~$${savings.toFixed(2)}).`,
    scope: 'opus-short-turns-7d',
    project_slug: null,
  }];
}

export function outlierTips(dbOrPath, todayIso = null) {
  const today = todayIso || new Date().toISOString();
  return withTipsDb(dbOrPath, (db) => _outlierTips(db, today));
}

function _outlierTips(db, todayIso) {
  const since = isoDaysAgo(todayIso, 7);
  const out = [];

  const big = db
    .prepare(
      `SELECT COUNT(*) AS n, AVG(result_tokens) AS avg_t
         FROM tool_calls
        WHERE tool_name='_tool_result' AND result_tokens > 50000 AND timestamp >= ?`
    )
    .get(since);
  if (big && num(big.n) >= 5) {
    const k = key('tool-bloat', 'result-50k+');
    if (!isDismissed(db, k)) {
      out.push({
        key: k, category: 'tool-bloat',
        title: `${Number(big.n)} tool results over 50k tokens this week`,
        body: `Average size is ${Math.trunc(num(big.avg_t)).toLocaleString('en-US')} tokens. Pipe long Bash output to head/tail and ask for narrower file reads.`,
        scope: 'result-50k+',
        project_slug: null,
      });
    }
  }

  const subagents = db
    .prepare(
      `SELECT agent_id, COUNT(*) AS n,
              AVG(input_tokens+output_tokens) AS mean_t,
              MAX(input_tokens+output_tokens) AS max_t
         FROM messages
        WHERE is_sidechain=1 AND agent_id IS NOT NULL AND timestamp >= ?
        GROUP BY agent_id HAVING n >= 10`
    )
    .all(since);
  for (const row of subagents) {
    const maxT = num(row.max_t);
    const meanT = num(row.mean_t) || 1;
    if (maxT > 6 * meanT && maxT > 50_000) {
      const k = key('subagent-outlier', row.agent_id);
      if (isDismissed(db, k)) continue;
      out.push({
        key: k, category: 'subagent-outlier',
        title: `Subagent ${row.agent_id} has cost outliers`,
        body: `Largest invocation used ${Math.trunc(maxT).toLocaleString('en-US')} tokens vs mean ${Math.trunc(meanT).toLocaleString('en-US')}. Worth checking what those did differently.`,
        scope: row.agent_id, project_slug: null,
      });
    }
  }
  return out;
}

function projectCwds(db) {
  const rows = db
    .prepare(
      `SELECT project_slug, MAX(timestamp) AS ts, cwd
         FROM messages
        WHERE cwd IS NOT NULL AND cwd != ''
        GROUP BY project_slug`
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.project_slug, r.cwd]));
}

export function allTips(dbPath, todayIso = null) {
  const today = todayIso || new Date().toISOString();
  return withDb(dbPath, (db) => {
    const tips = [
      ..._cacheDisciplineTips(db, today),
      ..._repeatedTargetTips(db, today),
      ..._rightSizeTips(db, today),
      ..._outlierTips(db, today),
    ];
    const cwds = projectCwds(db);
    for (const t of tips) {
      t.project_cwd = t.project_slug ? cwds[t.project_slug] || null : null;
    }
    return tips;
  });
}
