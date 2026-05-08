"""Rule-based tips engine — produces actionable suggestions from SQLite."""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import List, Optional

from .db import connect


def _iso_days_ago(today_iso: str, n: int) -> str:
    d = datetime.fromisoformat(today_iso.replace("Z", ""))
    return (d - timedelta(days=n)).isoformat()


def _key(category: str, scope: str) -> str:
    return f"{category}:{scope}"


def _is_dismissed(db_path, key: str) -> bool:
    with connect(db_path) as c:
        r = c.execute("SELECT dismissed_at FROM dismissed_tips WHERE tip_key=?", (key,)).fetchone()
    if not r:
        return False
    return (time.time() - r["dismissed_at"]) < 14 * 86400


def dismiss_tip(db_path, key: str) -> None:
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO dismissed_tips (tip_key, dismissed_at) VALUES (?, ?)",
            (key, time.time()),
        )
        c.commit()


def cache_discipline_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    sql = """
      SELECT project_slug,
             SUM(cache_read_tokens) AS cr,
             SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS rebuild
        FROM messages
       WHERE type='assistant' AND timestamp >= ?
       GROUP BY project_slug
       HAVING (cr + rebuild) > 100000
    """
    out = []
    with connect(db_path) as c:
        for row in c.execute(sql, (since,)):
            total = (row["cr"] or 0) + (row["rebuild"] or 0)
            hit = (row["cr"] or 0) / total if total else 0
            if hit < 0.40:
                key = _key("cache", row["project_slug"])
                if _is_dismissed(db_path, key):
                    continue
                out.append({
                    "key": key,
                    "category": "cache",
                    "title": f"Low cache hit rate in {row['project_slug']}",
                    "body": f"Cache hit rate is {hit*100:.0f}% over the last 7 days. Sessions that restart context frequently rebuild cache. Consider longer-lived sessions or fewer context resets.",
                    "scope": row["project_slug"],
                    "project_slug": row["project_slug"],
                })
    return out


def repeated_target_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        for row in c.execute("""
          SELECT project_slug, target, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions
            FROM tool_calls
           WHERE tool_name IN ('Read','Edit','Write') AND timestamp >= ?
           GROUP BY project_slug, target HAVING n > 10
           ORDER BY n DESC LIMIT 10
        """, (since,)):
            slug = row["project_slug"] or "?"
            target = row["target"] or "?"
            key = _key("repeat-file", f"{slug}:{target}")
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key, "category": "repeat-file",
                "title": f"{target} read {row['n']} times in {slug}",
                "body": f"This file was opened {row['n']} times across {row['sessions']} sessions in the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.",
                "scope": target,
                "project_slug": row["project_slug"],
                "target": target,
                "count": row["n"],
                "sessions": row["sessions"],
            })
        for row in c.execute("""
          SELECT project_slug, target, COUNT(*) AS n
            FROM tool_calls
           WHERE tool_name='Bash' AND timestamp >= ?
           GROUP BY project_slug, target HAVING n > 15
           ORDER BY n DESC LIMIT 10
        """, (since,)):
            slug = row["project_slug"] or "?"
            target = row["target"] or "?"
            key = _key("repeat-bash", f"{slug}:{target}")
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key, "category": "repeat-bash",
                "title": f"`{target}` ran {row['n']} times in {slug}",
                "body": f"This bash command ran {row['n']} times in the past 7 days. Consider a watch flag or shell alias.",
                "scope": target,
                "project_slug": row["project_slug"],
                "target": target,
                "count": row["n"],
            })
    return out


def right_size_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    sql = """
      SELECT project_slug,
             COUNT(*) AS n,
             SUM(input_tokens+cache_create_5m_tokens+cache_create_1h_tokens) AS in_tok,
             SUM(output_tokens) AS out_tok
        FROM messages
       WHERE type='assistant' AND model LIKE '%opus%'
         AND output_tokens < 500 AND is_sidechain = 0
         AND timestamp >= ?
       GROUP BY project_slug
    """
    out = []
    with connect(db_path) as c:
        rows = c.execute(sql, (since,)).fetchall()
    for row in rows:
        if (row["n"] or 0) < 10:
            continue
        api_opus   = ((row["in_tok"] or 0) * 15 + (row["out_tok"] or 0) * 75) / 1_000_000
        api_sonnet = ((row["in_tok"] or 0) *  3 + (row["out_tok"] or 0) * 15) / 1_000_000
        savings = api_opus - api_sonnet
        if savings < 1.0:
            continue
        slug = row["project_slug"] or "?"
        key = _key("right-size", f"{slug}:opus-short-turns-7d")
        if _is_dismissed(db_path, key):
            continue
        out.append({
            "key": key, "category": "right-size",
            "title": f"{row['n']} short Opus turns in {slug} might fit on Sonnet",
            "body": f"Opus turns under 500 output tokens cost ~${api_opus:.2f} in the last 7 days. Sonnet would have cost ~${api_sonnet:.2f} (savings ~${savings:.2f}).",
            "scope": f"{slug}:opus-short-turns-7d",
            "project_slug": row["project_slug"],
        })
    return out


def outlier_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out = []
    with connect(db_path) as c:
        for big in c.execute("""
          SELECT project_slug, COUNT(*) AS n, AVG(result_tokens) AS avg_t
            FROM tool_calls
           WHERE tool_name='_tool_result' AND result_tokens > 50000 AND timestamp >= ?
           GROUP BY project_slug
        """, (since,)):
            if (big["n"] or 0) < 5:
                continue
            slug = big["project_slug"] or "?"
            key = _key("tool-bloat", f"{slug}:result-50k+")
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key, "category": "tool-bloat",
                "title": f"{big['n']} tool results over 50k tokens in {slug} this week",
                "body": f"Average size is {int(big['avg_t']):,} tokens. Pipe long Bash output to head/tail and ask for narrower file reads.",
                "scope": f"{slug}:result-50k+",
                "project_slug": big["project_slug"],
            })
        for row in c.execute("""
          SELECT agent_id, COUNT(*) AS n,
                 AVG(input_tokens+output_tokens) AS mean_t,
                 MAX(input_tokens+output_tokens) AS max_t
            FROM messages
           WHERE is_sidechain=1 AND agent_id IS NOT NULL AND timestamp >= ?
           GROUP BY agent_id HAVING n >= 10
        """, (since,)):
            if (row["max_t"] or 0) > 6 * (row["mean_t"] or 1) and (row["max_t"] or 0) > 50_000:
                key = _key("subagent-outlier", row["agent_id"])
                if _is_dismissed(db_path, key):
                    continue
                out.append({
                    "key": key, "category": "subagent-outlier",
                    "title": f"Subagent {row['agent_id']} has cost outliers",
                    "body": f"Largest invocation used {int(row['max_t']):,} tokens vs mean {int(row['mean_t']):,}. Worth checking what those did differently.",
                    "scope": row["agent_id"],
                    "project_slug": None,
                })
    return out


def _project_cwds(db_path) -> dict:
    """Return {project_slug: most_recent_cwd} via SQLite's bare-column-with-MAX trick."""
    sql = """
      SELECT project_slug, MAX(timestamp) AS ts, cwd
        FROM messages
       WHERE cwd IS NOT NULL AND cwd != ''
       GROUP BY project_slug
    """
    with connect(db_path) as c:
        return {r["project_slug"]: r["cwd"] for r in c.execute(sql)}


def waste_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    """Heuristic detection of likely-wasted spend.

    Two signals today:
      1. Retry storms — same user prompt in the same session within 10 minutes.
         Almost always means the first attempt was interrupted or unsatisfactory.
      2. High-cost short turns — assistant turns with <100 output tokens but
         large billable input (>5k). Signature of an interrupted Stop, a
         refused tool call, or a slash command that bailed early.
    """
    today_iso = today_iso or datetime.utcnow().isoformat()
    since = _iso_days_ago(today_iso, 7)
    out: List[dict] = []
    with connect(db_path) as c:
        retry_sql = """
          SELECT a.session_id, a.project_slug,
                 COUNT(*) AS n,
                 SUM(LENGTH(COALESCE(a.prompt_text, ''))) AS chars
            FROM messages a
            JOIN messages b
              ON b.session_id = a.session_id
             AND b.type = 'user'
             AND b.uuid != a.uuid
             AND b.prompt_text = a.prompt_text
             AND b.timestamp > a.timestamp
             AND (julianday(b.timestamp) - julianday(a.timestamp)) * 86400.0 <= 600
           WHERE a.type = 'user'
             AND a.prompt_text IS NOT NULL
             AND LENGTH(a.prompt_text) >= 8
             AND a.is_sidechain = 0
             AND a.timestamp >= ?
           GROUP BY a.session_id
           HAVING n >= 2
        """
        for row in c.execute(retry_sql, (since,)):
            slug = row["project_slug"] or "?"
            sid = row["session_id"]
            key = _key("waste-retry", f"{slug}:{sid}")
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key, "category": "waste-retry",
                "title": f"Retry storm in session {sid[:8]} ({slug})",
                "body": f"{row['n']} duplicate prompts sent within 10 minutes — usually means the first attempts were interrupted or unsatisfactory. Each repeat re-pays for context.",
                "scope": sid,
                "project_slug": row["project_slug"],
                "count": row["n"],
            })

        short_sql = """
          SELECT project_slug, COUNT(*) AS n,
                 SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS in_tok,
                 SUM(output_tokens) AS out_tok
            FROM messages
           WHERE type='assistant' AND is_sidechain=0
             AND output_tokens < 100
             AND (input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) > 5000
             AND timestamp >= ?
           GROUP BY project_slug
           HAVING n >= 5
        """
        for row in c.execute(short_sql, (since,)):
            slug = row["project_slug"] or "?"
            key = _key("waste-aborted", slug)
            if _is_dismissed(db_path, key):
                continue
            out.append({
                "key": key, "category": "waste-aborted",
                "title": f"{row['n']} high-cost short turns in {slug}",
                "body": f"{row['n']} assistant turns this week paid for {int(row['in_tok'] or 0):,} input tokens but produced under 100 output tokens each. Usually a Stop key, a tool refusal, or a misfired slash command — context cost without any useful reply.",
                "scope": f"{slug}:short-turns-7d",
                "project_slug": row["project_slug"],
                "count": row["n"],
            })
    return out


def all_tips(db_path, today_iso: Optional[str] = None) -> List[dict]:
    tips = [
        *cache_discipline_tips(db_path, today_iso),
        *repeated_target_tips(db_path, today_iso),
        *right_size_tips(db_path, today_iso),
        *outlier_tips(db_path, today_iso),
        *waste_tips(db_path, today_iso),
    ]
    cwds = _project_cwds(db_path)
    for t in tips:
        t["project_cwd"] = cwds.get(t.get("project_slug")) if t.get("project_slug") else None
    return tips
