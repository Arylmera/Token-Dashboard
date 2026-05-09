"""Aggregation queries that power the dashboard tabs."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .projects import best_project_name
from .schema import connect
from ..pricing import cost_for


def _parse_iso(ts: str) -> datetime:
    """Parse the ISO timestamps Claude Code writes (always UTC, trailing Z)."""
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _range_clause(since, until, col: str = "timestamp"):
    where, args = [], []
    if since:
        where.append(f"{col} >= ?"); args.append(since)
    if until:
        where.append(f"{col} < ?"); args.append(until)
    return ((" AND " + " AND ".join(where)) if where else "", args)


def overview_totals(db_path, since=None, until=None) -> dict:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages_all WHERE 1=1 {rng}
    """
    with connect(db_path) as c:
        return dict(c.execute(sql, args).fetchone())


def expensive_prompts(db_path, limit: int = 50, sort: str = "tokens") -> list:
    """User prompt joined with the immediately-following assistant turn's tokens.

    sort="tokens" (default) → largest billable first.
    sort="recent"           → newest first.
    """
    order = "u.timestamp DESC" if sort == "recent" else "billable_tokens DESC"
    sql = f"""
      SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
             u.prompt_text, u.prompt_chars,
             a.uuid AS assistant_uuid, a.model,
             COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
               +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
             COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
        FROM messages_all u
        JOIN messages_all a ON a.parent_uuid = u.uuid AND a.type='assistant'
       WHERE u.type='user' AND u.prompt_text IS NOT NULL
       ORDER BY {order}
       LIMIT ?
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (limit,))]


def project_summary(db_path, since=None, until=None) -> list:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT project_slug,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             SUM(input_tokens)+SUM(output_tokens)
               +SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens) AS billable_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens
        FROM messages_all m
       WHERE 1=1 {rng}
       GROUP BY project_slug
       ORDER BY billable_tokens DESC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        for r in rows:
            cwds = [row["cwd"] for row in c.execute(
                "SELECT DISTINCT cwd FROM messages_all WHERE project_slug=? AND cwd IS NOT NULL",
                (r["project_slug"],),
            )]
            r["project_name"] = best_project_name(cwds, r["project_slug"])
    return _fold_worktree_rows(rows)


_NUMERIC_COLS = (
    "sessions", "turns", "input_tokens", "output_tokens",
    "billable_tokens", "cache_read_tokens",
)


def _fold_worktree_rows(rows: list) -> list:
    """Collapse worktree-derived rows into their parent project (same project_name).

    Worktree sessions live under separate `project_slug` values (one per
    `<repo>/.claude/worktrees/<name>`), but `best_project_name` resolves all
    of them to the parent repo's basename. Without folding, the parent shows
    up once plus N times for each worktree — confusing the projects view.
    """
    folded: dict = {}
    for r in rows:
        key = r.get("project_name") or r.get("project_slug")
        if key not in folded:
            folded[key] = dict(r)
            continue
        agg = folded[key]
        for col in _NUMERIC_COLS:
            agg[col] = (agg.get(col) or 0) + (r.get(col) or 0)
        if "worktrees" in (agg.get("project_slug") or "").lower():
            agg["project_slug"] = r["project_slug"]
    return sorted(
        folded.values(),
        key=lambda x: x.get("billable_tokens") or 0,
        reverse=True,
    )


def tool_token_breakdown(db_path, since=None, until=None) -> list:
    rng, args = _range_clause(since, until, col="tc.timestamp")
    sql = f"""
      SELECT tc.tool_name AS tool_name,
             COUNT(*) AS calls,
             COALESCE(SUM(tr.result_tokens),0) AS result_tokens
        FROM tool_calls_all tc
        LEFT JOIN tool_calls_all tr
               ON tr.tool_name = '_tool_result'
              AND tr.session_id = tc.session_id
              AND tr.use_id = tc.use_id
       WHERE tc.tool_name != '_tool_result' {rng}
       GROUP BY tc.tool_name
       ORDER BY calls DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def recent_sessions(db_path, limit: int = 20, since=None, until=None, pricing=None, tag=None, order_by: str = "recent") -> list:
    rng, args = _range_clause(since, until)
    tag_join, tag_filter, tag_args = "", "", []
    if tag:
        tag_join = "JOIN session_tags_all st ON st.session_id = m.session_id"
        tag_filter = "AND st.tag = ?"
        tag_args = [tag]
    if order_by == "cost":
        # Proxy ordering by billable tokens in SQL; re-sort by computed cost in Python.
        # Widen the candidate pool so cheap-token / expensive-model sessions still surface.
        order_clause = ("SUM(m.input_tokens)+SUM(m.output_tokens)"
                        "+SUM(m.cache_create_5m_tokens)+SUM(m.cache_create_1h_tokens) DESC")
        fetch_limit = min(max(limit * 5, 100), 500)
    else:
        order_clause = "ended DESC"
        fetch_limit = limit
    sql = f"""
      SELECT m.session_id AS session_id, m.project_slug AS project_slug,
             MIN(m.timestamp) AS started, MAX(m.timestamp) AS ended,
             SUM(CASE WHEN m.type='user' THEN 1 ELSE 0 END) AS turns,
             SUM(m.input_tokens)+SUM(m.output_tokens) AS tokens
        FROM messages_all m
        {tag_join}
       WHERE 1=1 {rng} {tag_filter}
       GROUP BY m.session_id
       ORDER BY {order_clause}
       LIMIT ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (*args, *tag_args, fetch_limit))]
        slug_cache = {}
        for r in rows:
            slug = r["project_slug"]
            if slug not in slug_cache:
                cwds = [row["cwd"] for row in c.execute(
                    "SELECT DISTINCT cwd FROM messages_all WHERE project_slug=? AND cwd IS NOT NULL",
                    (slug,),
                )]
                slug_cache[slug] = best_project_name(cwds, slug)
            r["project_name"] = slug_cache[slug]

        if pricing and rows:
            ids = [r["session_id"] for r in rows]
            placeholders = ",".join("?" * len(ids))
            cost_sql = f"""
              SELECT session_id, model,
                     COALESCE(SUM(input_tokens),0)           AS input_tokens,
                     COALESCE(SUM(output_tokens),0)          AS output_tokens,
                     COALESCE(SUM(cache_read_tokens),0)      AS cache_read_tokens,
                     COALESCE(SUM(cache_create_5m_tokens),0) AS cache_create_5m_tokens,
                     COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_1h_tokens
                FROM messages_all
               WHERE session_id IN ({placeholders}) AND model IS NOT NULL
               GROUP BY session_id, model
            """
            costs = {sid: 0.0 for sid in ids}
            estimated = {sid: False for sid in ids}
            top_model = {sid: (None, -1) for sid in ids}  # (model, billable_tokens)
            for cr in c.execute(cost_sql, ids):
                cr = dict(cr)
                c_res = cost_for(cr["model"], cr, pricing)
                if c_res["usd"] is not None:
                    costs[cr["session_id"]] += c_res["usd"]
                if c_res["estimated"]:
                    estimated[cr["session_id"]] = True
                billable = (cr["input_tokens"] + cr["output_tokens"]
                            + cr["cache_create_5m_tokens"] + cr["cache_create_1h_tokens"])
                if billable > top_model[cr["session_id"]][1]:
                    top_model[cr["session_id"]] = (cr["model"], billable)
            for r in rows:
                r["cost_usd"] = round(costs[r["session_id"]], 6)
                r["cost_estimated"] = estimated[r["session_id"]]
                r["model"] = top_model[r["session_id"]][0]

        if rows:
            ids = [r["session_id"] for r in rows]
            placeholders = ",".join("?" * len(ids))
            fp_sql = f"""
              SELECT m.session_id, m.prompt_text
                FROM messages_all m
                JOIN (
                  SELECT session_id, MIN(timestamp) AS t
                    FROM messages_all
                   WHERE type='user'
                     AND prompt_text IS NOT NULL AND prompt_text != ''
                     AND (is_sidechain IS NULL OR is_sidechain = 0)
                     AND session_id IN ({placeholders})
                   GROUP BY session_id
                ) f ON f.session_id = m.session_id AND f.t = m.timestamp
               WHERE m.type='user'
            """
            first_prompts = {}
            for fr in c.execute(fp_sql, ids):
                fr = dict(fr)
                first_prompts.setdefault(fr["session_id"], fr["prompt_text"])
            for r in rows:
                r["first_prompt"] = first_prompts.get(r["session_id"])

        if rows:
            tag_map = session_tags(db_path, [r["session_id"] for r in rows])
            for r in rows:
                r["tags"] = tag_map.get(r["session_id"], [])
    if order_by == "cost":
        rows.sort(key=lambda r: r.get("cost_usd") or 0, reverse=True)
        rows = rows[:limit]
    return rows


def session_turns(db_path, session_id: str) -> list:
    sql = """
      SELECT uuid, parent_uuid, type, timestamp, model, is_sidechain, agent_id,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             prompt_text, prompt_chars, tool_calls_json, project_slug, cwd
        FROM messages_all
       WHERE session_id = ?
       ORDER BY timestamp ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (session_id,))]


def daily_token_breakdown(db_path, since=None, until=None) -> list:
    """One row per day: stacked bar data for input/output/cache_read/cache_create."""
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT substr(timestamp, 1, 10) AS day,
             COALESCE(SUM(input_tokens),0)      AS input_tokens,
             COALESCE(SUM(output_tokens),0)     AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)
               + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens
        FROM messages_all
       WHERE timestamp IS NOT NULL {rng}
       GROUP BY day
       ORDER BY day ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def hourly_breakdown(db_path, hours: int = 24) -> list:
    """Per-hour token totals for the last `hours` hours, grouped by model.

    Returns rows with (hour_ago, model, *_tokens). hour_ago=0 is the current
    hour bucket; the caller maps these into a fixed-length array.
    """
    sql = """
      SELECT CAST((strftime('%s','now') - strftime('%s', timestamp)) / 3600 AS INT) AS hour_ago,
             COALESCE(model, 'unknown') AS model,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages_all
       WHERE type='assistant' AND timestamp IS NOT NULL
         AND timestamp >= datetime('now', ?)
       GROUP BY hour_ago, model
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (f"-{int(hours)} hours",))]


def skill_breakdown(db_path, since=None, until=None) -> list:
    """Per-skill invocation counts, distinct sessions, last-used timestamp.

    Token attribution per skill is not included: in Claude Code, a Skill's
    content is loaded via a system-reminder on the next turn, not as the
    tool_result body — so `result_tokens` on _tool_result rows reflects the
    activation ack (tiny), not the skill definition (which is what actually
    fills context). For now we only expose the reliable counts.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT target AS skill,
             COUNT(*) AS invocations,
             COUNT(DISTINCT session_id) AS sessions,
             MAX(timestamp) AS last_used
        FROM tool_calls_all
       WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng}
       GROUP BY target
       ORDER BY invocations DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def _tier_for_model(model: str, pricing: dict) -> str:
    if not model:
        return "sonnet"
    rates = (pricing.get("models") or {}).get(model)
    if rates and rates.get("tier"):
        return rates["tier"]
    m = model.lower()
    for tier in ("opus", "sonnet", "haiku"):
        if tier in m:
            return tier
    return "sonnet"


def window_billable_tokens(db_path, since_iso: str, pricing: "dict | None" = None) -> int:
    """Sum of billable tokens since `since_iso`, weighted to Sonnet-equivalent
    units when `pricing["tier_weight"]` is provided.

    Anthropic's plan caps are described in "Sonnet hours" / "Opus hours", so
    raw token sums under-report consumption when Opus is in the mix. Weighting
    each assistant message by its tier (opus > sonnet > haiku) gets us closer
    to the cap unit Anthropic actually enforces. When `pricing` is None or has
    no `tier_weight`, falls back to unweighted sums (legacy behavior).
    """
    weights = (pricing or {}).get("tier_weight") if pricing else None
    if not weights:
        sql = """
          SELECT COALESCE(SUM(input_tokens),0)
                 + COALESCE(SUM(output_tokens),0)
                 + COALESCE(SUM(cache_create_5m_tokens),0)
                 + COALESCE(SUM(cache_create_1h_tokens),0) AS billable
            FROM messages_all
           WHERE type='assistant' AND timestamp >= ?
        """
        with connect(db_path) as c:
            row = c.execute(sql, (since_iso,)).fetchone()
        return int(row["billable"] or 0)

    sql = """
      SELECT model,
             COALESCE(SUM(input_tokens),0)
             + COALESCE(SUM(output_tokens),0)
             + COALESCE(SUM(cache_create_5m_tokens),0)
             + COALESCE(SUM(cache_create_1h_tokens),0) AS billable
        FROM messages_all
       WHERE type='assistant' AND timestamp >= ?
       GROUP BY model
    """
    total = 0.0
    with connect(db_path) as c:
        for row in c.execute(sql, (since_iso,)):
            tier = _tier_for_model(row["model"], pricing)
            total += float(row["billable"] or 0) * float(weights.get(tier, 1.0))
    return int(round(total))


SESSION_HOURS = 5


def current_session_anchor(db_path, now_iso: str) -> "str | None":
    """Start of the currently-active anchored 5h Claude Code session.

    Anthropic anchors the 5h rate limit at the first assistant message of a
    session; the session ends `SESSION_HOURS` later, and the next assistant
    message after that point starts a fresh anchor. Returns the ISO timestamp
    of the active anchor, or None when no message has landed in the last 5h
    (no active session).

    A 24h lookback covers all realistic cases: Claude sessions cap at 5h, so
    any 24h window contains at least one true session boundary unless the
    user has been idle for >24h — in which case the answer is None anyway.
    """
    now = _parse_iso(now_iso)
    cutoff = (now - timedelta(hours=24)).isoformat().replace("+00:00", "Z")
    sql = """
      SELECT timestamp FROM messages_all
       WHERE type='assistant' AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC
    """
    with connect(db_path) as c:
        rows = [r["timestamp"] for r in c.execute(sql, (cutoff, now_iso))]
    if not rows:
        return None
    session = timedelta(hours=SESSION_HOURS)
    anchor = _parse_iso(rows[0])
    for ts in rows[1:]:
        t = _parse_iso(ts)
        if t >= anchor + session:
            anchor = t
    if now >= anchor + session:
        return None
    return anchor.isoformat().replace("+00:00", "Z")


PLAN_TOOLS    = ("Read", "Grep", "Glob", "WebSearch", "WebFetch", "Task", "Skill")
EXECUTE_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit", "Bash")


def phase_split(db_path, since=None, until=None) -> list:
    """Per-turn classification into plan / execute / other.

    Tokens are billed per assistant turn, not per tool call. We attribute
    each turn's billable tokens (and cache_read for total) to the dominant
    phase of its tool calls. Turns with no tool calls — or with an
    unrecognized mix — fall into 'other'. is_sidechain turns are excluded
    so subagent traffic doesn't double-count against the parent.
    """
    rng, args = _range_clause(since, until, col="m.timestamp")
    plan_in = ",".join("?" * len(PLAN_TOOLS))
    exec_in = ",".join("?" * len(EXECUTE_TOOLS))
    sql = f"""
      SELECT m.uuid, m.model,
             COALESCE(m.input_tokens,0) AS input_tokens,
             COALESCE(m.output_tokens,0) AS output_tokens,
             COALESCE(m.cache_read_tokens,0) AS cache_read_tokens,
             COALESCE(m.cache_create_5m_tokens,0) AS cache_create_5m_tokens,
             COALESCE(m.cache_create_1h_tokens,0) AS cache_create_1h_tokens,
             SUM(CASE WHEN tc.tool_name IN ({plan_in}) THEN 1 ELSE 0 END) AS plan_n,
             SUM(CASE WHEN tc.tool_name IN ({exec_in}) THEN 1 ELSE 0 END) AS exec_n,
             SUM(CASE WHEN tc.tool_name IS NOT NULL
                       AND tc.tool_name != '_tool_result'
                       AND tc.tool_name NOT IN ({plan_in})
                       AND tc.tool_name NOT IN ({exec_in})
                      THEN 1 ELSE 0 END) AS other_n
        FROM messages_all m
        LEFT JOIN tool_calls_all tc
               ON tc.message_uuid = m.uuid AND tc.tool_name != '_tool_result'
       WHERE m.type='assistant' AND m.is_sidechain = 0 {rng}
       GROUP BY m.uuid
    """
    params = list(PLAN_TOOLS) + list(EXECUTE_TOOLS) + list(PLAN_TOOLS) + list(EXECUTE_TOOLS) + list(args)
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, params)]


def session_tags(db_path, session_ids) -> dict:
    """Return {session_id: [tag, ...]} for the given session ids."""
    if not session_ids:
        return {}
    placeholders = ",".join("?" * len(session_ids))
    sql = f"SELECT session_id, tag FROM session_tags_all WHERE session_id IN ({placeholders}) ORDER BY tag"
    out: dict = {sid: [] for sid in session_ids}
    with connect(db_path) as c:
        for r in c.execute(sql, list(session_ids)):
            out.setdefault(r["session_id"], []).append(r["tag"])
    return out


def all_tags(db_path) -> list:
    """All tags + how many sessions each is attached to."""
    sql = """
      SELECT tag, COUNT(*) AS sessions
        FROM session_tags_all
       GROUP BY tag
       ORDER BY sessions DESC, tag ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql)]


def add_session_tag(db_path, session_id: str, tag: str) -> None:
    import time as _time
    with connect(db_path) as c:
        c.execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) VALUES (?, ?, ?)",
            (session_id, tag, _time.time()),
        )
        c.commit()


def remove_session_tag(db_path, session_id: str, tag: str) -> None:
    with connect(db_path) as c:
        c.execute(
            "DELETE FROM session_tags WHERE session_id=? AND tag=?",
            (session_id, tag),
        )
        c.commit()


def session_ids_with_tag(db_path, tag: str) -> list:
    with connect(db_path) as c:
        return [r["session_id"] for r in c.execute(
            "SELECT session_id FROM session_tags_all WHERE tag=?", (tag,))]


def model_breakdown(db_path, since=None, until=None) -> list:
    """Per-model token totals + turn count. Caller computes cost via pricing."""
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT COALESCE(model, 'unknown') AS model,
             COUNT(*) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages_all
       WHERE type = 'assistant' {rng}
       GROUP BY model
       ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]
