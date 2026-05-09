"""HTTP routing: build_handler returns the BaseHTTPRequestHandler subclass.

Each endpoint is a small private function `(handler, db_path, pricing, qs) -> None`,
dispatched from a dict to keep do_GET readable.
"""
from __future__ import annotations

import http.server
import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from datetime import datetime, timedelta, timezone

from ..db import (
    EXECUTE_TOOLS,
    PLAN_TOOLS,
    SESSION_HOURS,
    add_session_tag,
    all_tags,
    current_session_anchor,
    daily_token_breakdown,
    expensive_prompts,
    hourly_breakdown,
    model_breakdown,
    overview_totals,
    phase_split,
    project_summary,
    recent_sessions,
    remove_session_tag,
    session_turns,
    skill_breakdown,
    tool_token_breakdown,
    window_billable_tokens,
)
from ..preferences import (
    BADGE_METRICS,
    BADGE_WINDOW_MODES,
    BUDGET_KEYS,
    get_badge_dock_enabled,
    get_badge_menubar_enabled,
    get_badge_metric,
    get_badge_window_mode,
    get_budgets,
    get_glass_enabled,
    get_glass_opacity,
    get_limits_enabled,
    set_badge_dock_enabled,
    set_badge_menubar_enabled,
    set_badge_metric,
    set_badge_window_mode,
    set_budget,
    set_glass_enabled,
    set_glass_opacity,
    set_limits_enabled,
)
from ..db.sources import (
    add_source,
    list_sources,
    remove_source,
    set_source_enabled,
)
from ..pricing import cost_for, get_plan, load_pricing, set_plan
from ..scanner import scan_dir
from ..skills import cached_catalog
from ..tips import all_tips, dismiss_tip
from .http_utils import (
    MAX_IMPORT_BYTES,
    MAX_POST_BYTES,
    clamp_limit,
    pricing_path,
    send_error_json,
    send_json,
    serve_static,
)
from .sse import EVENTS
from .sse import stream as sse_stream

_STARTED_AT: float | None = None


def set_started_at(ts: float) -> None:
    """Called by scan_loop.run after the listening socket is bound."""
    global _STARTED_AT
    _STARTED_AT = ts


def _read_version() -> str:
    here = Path(__file__).resolve().parent.parent.parent
    candidates = [here / "VERSION", Path(__file__).resolve().parent.parent / "VERSION"]
    for p in candidates:
        try:
            return p.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return "0.0.0"


_VERSION = _read_version()


class _PricingCache:
    """Reloads pricing.json when its mtime changes — no server restart needed."""

    def __init__(self) -> None:
        self._mtime: float | None = None
        self._data: dict = {}
        self._path: Path | None = None

    def get(self) -> dict:
        path = pricing_path()
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = None
        if path != self._path or mtime != self._mtime or not self._data:
            self._data = load_pricing(path)
            self._path = path
            self._mtime = mtime
        return self._data


def _api_overview(handler, db_path, pricing, qs):
    since = qs.get("since", [None])[0]
    until = qs.get("until", [None])[0]
    totals = overview_totals(db_path, since, until)
    cost_usd = 0.0
    for m in model_breakdown(db_path, since, until):
        c = cost_for(m["model"], m, pricing)
        if c["usd"] is not None:
            cost_usd += c["usd"]
    totals["cost_usd"] = round(cost_usd, 4)
    send_json(handler, totals)


def _api_prompts(handler, db_path, pricing, qs):
    limit = clamp_limit(qs.get("limit", ["50"])[0], 50)
    sort = qs.get("sort", ["tokens"])[0]
    rows = expensive_prompts(db_path, limit=limit, sort=sort)
    for r in rows:
        c = cost_for(r["model"], {
            "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": r["cache_read_tokens"],
            "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
        }, pricing)
        r["estimated_cost_usd"] = c["usd"]
    send_json(handler, rows)


def _api_projects(handler, db_path, pricing, qs):
    send_json(handler, project_summary(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def _api_tools(handler, db_path, pricing, qs):
    send_json(handler, tool_token_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def _api_sessions(handler, db_path, pricing, qs):
    order_raw = (qs.get("order", ["recent"])[0] or "recent").lower()
    order_by = "cost" if order_raw == "cost" else "recent"
    send_json(handler, recent_sessions(
        db_path,
        limit=clamp_limit(qs.get("limit", ["20"])[0], 20),
        since=qs.get("since", [None])[0],
        until=qs.get("until", [None])[0],
        pricing=pricing,
        tag=qs.get("tag", [None])[0] or None,
        order_by=order_by,
    ))


def _api_tags(handler, db_path, pricing, qs):
    send_json(handler, all_tags(db_path))


def _api_phase_split(handler, db_path, pricing, qs):
    """Aggregate per-turn billable tokens into plan / execute / other phases.

    Apportionment rule: a turn is classified by the dominant tool count in
    PLAN_TOOLS vs EXECUTE_TOOLS. Ties between plan and execute fall to plan
    (information-gathering tools have less direct cost amplification). Turns
    with no recognised tool calls drop into 'other'."""
    rows = phase_split(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0])
    bins = {
        "plan":    {"turns": 0, "billable_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "cost_estimated": False},
        "execute": {"turns": 0, "billable_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "cost_estimated": False},
        "other":   {"turns": 0, "billable_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "cost_estimated": False},
    }
    for r in rows:
        plan_n, exec_n, other_n = r["plan_n"] or 0, r["exec_n"] or 0, r["other_n"] or 0
        if plan_n == 0 and exec_n == 0 and other_n == 0:
            phase = "other"
        elif exec_n > plan_n:
            phase = "execute"
        elif plan_n > 0:
            phase = "plan"
        else:
            phase = "other"
        billable = (r["input_tokens"] + r["output_tokens"]
                    + r["cache_create_5m_tokens"] + r["cache_create_1h_tokens"])
        c = cost_for(r["model"], r, pricing)
        bins[phase]["turns"] += 1
        bins[phase]["billable_tokens"] += billable
        bins[phase]["cache_read_tokens"] += r["cache_read_tokens"]
        if c["usd"] is not None:
            bins[phase]["cost_usd"] += c["usd"]
        if c["estimated"]:
            bins[phase]["cost_estimated"] = True
    for v in bins.values():
        v["cost_usd"] = round(v["cost_usd"], 6)
    send_json(handler, {
        "plan_tools": list(PLAN_TOOLS),
        "execute_tools": list(EXECUTE_TOOLS),
        **bins,
    })


def _budget_window_payload(used_usd: float, cap: "float | None", elapsed_frac: float) -> dict:
    if cap is None:
        return {"used_usd": round(used_usd, 4), "cap_usd": None,
                "pct_used": None, "projected_usd": None, "status": "ok"}
    pct_used = used_usd / cap if cap > 0 else 0.0
    projected = used_usd / elapsed_frac if elapsed_frac > 0 else used_usd
    if pct_used >= 1.0 or projected > cap * 1.25:
        status = "over"
    elif pct_used >= 0.8 or projected > cap:
        status = "warn"
    else:
        status = "ok"
    return {
        "used_usd":     round(used_usd, 4),
        "cap_usd":      round(cap, 2),
        "pct_used":     round(pct_used, 4),
        "projected_usd": round(projected, 4),
        "status":       status,
    }


def _spend_since(db_path, since_iso: str, pricing) -> float:
    total = 0.0
    for m in model_breakdown(db_path, since=since_iso, until=None):
        c = cost_for(m["model"], m, pricing)
        if c["usd"] is not None:
            total += c["usd"]
    return total


def _api_budget(handler, db_path, pricing, qs):
    """Budget caps + spend-to-date + linear projection for daily/weekly/monthly windows.

    Projection is a naive linear extrapolation: spend / elapsed_frac. Honest
    enough for early-period nudges; gets closer to actual as the period
    advances."""
    budgets = get_budgets(db_path)
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=now.weekday())
    month_start = day_start.replace(day=1)
    iso = lambda d: d.isoformat().replace("+00:00", "Z")
    day_used   = _spend_since(db_path, iso(day_start),   pricing)
    week_used  = _spend_since(db_path, iso(week_start),  pricing)
    month_used = _spend_since(db_path, iso(month_start), pricing)
    seconds_in_day = 86400
    day_elapsed = max(1.0, (now - day_start).total_seconds()) / seconds_in_day
    week_elapsed = max(1.0, (now - week_start).total_seconds()) / (7 * seconds_in_day)
    days_in_month = (month_start.replace(month=month_start.month % 12 + 1, day=1)
                     - timedelta(days=1)).day if month_start.month != 12 else 31
    month_elapsed = max(1.0, (now - month_start).total_seconds()) / (days_in_month * seconds_in_day)
    send_json(handler, {
        "daily":   _budget_window_payload(day_used,   budgets["budget_daily_usd"],   day_elapsed),
        "weekly":  _budget_window_payload(week_used,  budgets["budget_weekly_usd"],  week_elapsed),
        "monthly": _budget_window_payload(month_used, budgets["budget_monthly_usd"], month_elapsed),
    })


def _api_export_csv(handler, db_path, pricing, qs):
    """Sessions CSV with optional since/until/tag filters. RFC 4180 quoting."""
    import csv
    import io
    rows = recent_sessions(
        db_path,
        limit=10_000,
        since=qs.get("since", [None])[0],
        until=qs.get("until", [None])[0],
        pricing=pricing,
        tag=qs.get("tag", [None])[0] or None,
    )
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "session_id", "project_slug", "project_name",
        "started", "ended", "turns", "tokens", "cost_usd",
        "model", "tags", "first_prompt",
    ])
    for r in rows:
        w.writerow([
            r.get("session_id") or "",
            r.get("project_slug") or "",
            r.get("project_name") or "",
            r.get("started") or "",
            r.get("ended") or "",
            r.get("turns") or 0,
            r.get("tokens") or 0,
            f"{r.get('cost_usd') or 0:.6f}",
            r.get("model") or "",
            ",".join(r.get("tags") or []),
            (r.get("first_prompt") or "").replace("\n", " ").strip()[:500],
        ])
    body = buf.getvalue().encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/csv; charset=utf-8")
    handler.send_header("Content-Disposition",
                        'attachment; filename="token-dashboard-sessions.csv"')
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _api_export_db(handler, db_path, pricing, qs):
    """Stream a consistent snapshot of the SQLite DB.

    Uses sqlite3's online backup API, so a concurrent scan_loop write doesn't
    corrupt the download. We backup to a temp file (lets sqlite handle locking
    cleanly), read it into memory, send with Content-Length, then unlink.
    Memory cost is the DB size; for a desktop tool scanning local JSONLs that's
    tens of MB at most.
    """
    import os as _os
    import sqlite3 as _sqlite3
    import tempfile as _tempfile
    from datetime import datetime as _dt

    fd, tmp_path = _tempfile.mkstemp(suffix=".db", prefix="td-export-")
    _os.close(fd)
    try:
        with _sqlite3.connect(db_path) as src, _sqlite3.connect(tmp_path) as dst:
            src.backup(dst)
        body = Path(tmp_path).read_bytes()
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass

    stamp = _dt.utcnow().strftime("%Y%m%d-%H%M%S")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-sqlite3")
    handler.send_header(
        "Content-Disposition",
        f'attachment; filename="token-dashboard-{stamp}.db"',
    )
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _api_import_db(handler, db_path) -> None:
    """Merge an uploaded SQLite snapshot into the local DB.

    Wire format: raw bytes in the POST body (no multipart). Caller sends
    Content-Type: application/x-sqlite3 and the file as the body. Dedup is
    natural — messages PK on uuid, session_tags PK on (session_id, tag) — so
    INSERT OR IGNORE handles it. tool_calls has an autoincrement id so we
    delete-then-insert per message_uuid touched by the import; that keeps
    repeat imports idempotent without depending on a synthetic key.

    The whole merge runs in a single transaction so a malformed source DB
    leaves the local DB unchanged.
    """
    import os as _os
    import sqlite3 as _sqlite3
    import tempfile as _tempfile

    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        return send_error_json(handler, 400, "invalid Content-Length")
    if length <= 0:
        return send_error_json(handler, 400, "empty body")
    if length > MAX_IMPORT_BYTES:
        return send_error_json(
            handler, 413, f"upload too large (max {MAX_IMPORT_BYTES} bytes)")

    fd, tmp_path = _tempfile.mkstemp(suffix=".db", prefix="td-import-")
    try:
        with _os.fdopen(fd, "wb") as fh:
            remaining = length
            while remaining > 0:
                chunk = handler.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining != 0:
            return send_error_json(handler, 400, "truncated upload")

        # Magic-header check before we ATTACH — sqlite errors on attach are
        # less helpful than failing fast here.
        with open(tmp_path, "rb") as fh:
            head = fh.read(16)
        if not head.startswith(b"SQLite format 3\x00"):
            return send_error_json(handler, 400, "not a SQLite database")

        with _sqlite3.connect(db_path) as conn:
            # ATTACH path is interpolated, not bound — sqlite forbids `?` here.
            # Quote-escape just in case the temp dir contains a single quote
            # (extremely unlikely on stock macOS/Linux, but cheap to harden).
            attach_path = tmp_path.replace("'", "''")
            conn.execute(f"ATTACH DATABASE '{attach_path}' AS src")
            try:
                src_tables = {
                    row[0] for row in conn.execute(
                        "SELECT name FROM src.sqlite_master WHERE type='table'")
                }
                missing = {"messages", "tool_calls"} - src_tables
                if missing:
                    return send_error_json(
                        handler, 400,
                        f"source DB missing required tables: {sorted(missing)}")

                conn.execute("BEGIN")

                # Count what's actually new before we INSERT, so the response
                # reports adds (not the no-op rows that hit OR IGNORE).
                msg_added = conn.execute(
                    "SELECT COUNT(*) FROM src.messages s "
                    "WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.uuid = s.uuid)"
                ).fetchone()[0]

                # messages — uuid PK is the natural dedup key.
                src_cols = [row[1] for row in conn.execute("PRAGMA src.table_info(messages)")]
                local_cols = [row[1] for row in conn.execute("PRAGMA table_info(messages)")]
                shared = [c for c in local_cols if c in src_cols]
                col_list = ", ".join(shared)
                conn.execute(
                    f"INSERT OR IGNORE INTO messages ({col_list}) "
                    f"SELECT {col_list} FROM src.messages"
                )

                # tool_calls — no natural unique key. Wipe local rows for any
                # message_uuid present in src (a no-op set if those messages
                # didn't already exist locally), then re-insert from src.
                conn.execute("""
                    DELETE FROM tool_calls
                     WHERE message_uuid IN (SELECT uuid FROM src.messages)
                """)
                src_tc_cols = [row[1] for row in conn.execute("PRAGMA src.table_info(tool_calls)")]
                local_tc_cols = [row[1] for row in conn.execute("PRAGMA table_info(tool_calls)")]
                shared_tc = [c for c in local_tc_cols if c in src_tc_cols and c != "id"]
                tc_col_list = ", ".join(shared_tc)
                conn.execute(
                    f"INSERT INTO tool_calls ({tc_col_list}) "
                    f"SELECT {tc_col_list} FROM src.tool_calls"
                )
                tc_added = conn.execute(
                    "SELECT COUNT(*) FROM src.tool_calls"
                ).fetchone()[0]

                # session_tags — composite PK, but only present in newer DBs.
                tags_added = 0
                if "session_tags" in src_tables:
                    tags_added = conn.execute(
                        "SELECT COUNT(*) FROM src.session_tags s "
                        "WHERE NOT EXISTS (SELECT 1 FROM session_tags t "
                        "WHERE t.session_id = s.session_id AND t.tag = s.tag)"
                    ).fetchone()[0]
                    conn.execute("""
                        INSERT OR IGNORE INTO session_tags (session_id, tag, created_at)
                        SELECT session_id, tag, created_at FROM src.session_tags
                    """)

                conn.commit()
            finally:
                conn.execute("DETACH DATABASE src")

        send_json(handler, {
            "ok": True,
            "messages_added": msg_added,
            "tool_calls_imported": tc_added,
            "tags_added": tags_added,
        })
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass


def _api_sources_list(handler, db_path, pricing, qs):
    send_json(handler, list_sources(db_path))


def _api_sources_add(handler, db_path) -> None:
    """Upload a .db file and register it as a toggleable source.

    Wire format mirrors /api/import.db: raw bytes in body, optional
    X-Source-Filename header to name it (falls back to a timestamped
    default). On success returns the registry row.
    """
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        return send_error_json(handler, 400, "invalid Content-Length")
    if length <= 0:
        return send_error_json(handler, 400, "empty body")
    if length > MAX_IMPORT_BYTES:
        return send_error_json(
            handler, 413, f"upload too large (max {MAX_IMPORT_BYTES} bytes)")

    body = bytearray()
    remaining = length
    while remaining > 0:
        chunk = handler.rfile.read(min(remaining, 1 << 20))
        if not chunk:
            break
        body.extend(chunk)
        remaining -= len(chunk)
    if remaining != 0:
        return send_error_json(handler, 400, "truncated upload")

    filename = handler.headers.get("X-Source-Filename") or f"source-{int(time.time())}.db"
    try:
        row = add_source(db_path, filename, bytes(body))
    except ValueError as e:
        return send_error_json(handler, 400, str(e))
    EVENTS.publish({"type": "sources"})
    send_json(handler, row)


def _api_sources_toggle(handler, db_path, name: str, body: dict) -> None:
    if not set_source_enabled(db_path, name, bool(body.get("enabled"))):
        return send_error_json(handler, 404, "source not found")
    EVENTS.publish({"type": "sources"})
    send_json(handler, {"ok": True, "name": name, "enabled": bool(body.get("enabled"))})


def _api_sources_delete(handler, db_path, name: str) -> None:
    if not remove_source(db_path, name):
        return send_error_json(handler, 404, "source not found")
    EVENTS.publish({"type": "sources"})
    send_json(handler, {"ok": True, "name": name})


def _api_daily(handler, db_path, pricing, qs):
    send_json(handler, daily_token_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def _api_hourly(handler, db_path, pricing, qs):
    try:
        hours = max(1, min(168, int(qs.get("hours", ["24"])[0])))
    except ValueError:
        hours = 24
    rows = hourly_breakdown(db_path, hours=hours)
    buckets = [{"cost_usd": 0.0, "billable_tokens": 0} for _ in range(hours)]
    for r in rows:
        ha = int(r["hour_ago"])
        if ha < 0 or ha >= hours:
            continue
        idx = hours - 1 - ha
        c = cost_for(r["model"], r, pricing)
        if c["usd"] is not None:
            buckets[idx]["cost_usd"] += c["usd"]
        buckets[idx]["billable_tokens"] += (
            r["input_tokens"] + r["output_tokens"]
            + r["cache_create_5m_tokens"] + r["cache_create_1h_tokens"]
        )
    for b in buckets:
        b["cost_usd"] = round(b["cost_usd"], 6)
    send_json(handler, buckets)


def _api_skills(handler, db_path, pricing, qs):
    rows = skill_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0])
    catalog = cached_catalog()
    for r in rows:
        info = catalog.get(r["skill"])
        r["tokens_per_call"] = info["tokens"] if info else None
    send_json(handler, rows)


def _api_by_model(handler, db_path, pricing, qs):
    rows = model_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0])
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        r["cost_usd"] = c["usd"]
        r["cost_estimated"] = c["estimated"]
    send_json(handler, rows)


def _api_tips(handler, db_path, pricing, qs):
    send_json(handler, all_tips(db_path))


def _api_plan(handler, db_path, pricing, qs):
    send_json(handler, {"plan": get_plan(db_path), "pricing": pricing})


def _api_preferences(handler, db_path, pricing, qs):
    send_json(handler, {
        "badge_metric": get_badge_metric(db_path),
        "badge_metrics": list(BADGE_METRICS),
        "badge_dock_enabled": get_badge_dock_enabled(db_path),
        "badge_menubar_enabled": get_badge_menubar_enabled(db_path),
        "badge_window_mode": get_badge_window_mode(db_path),
        "badge_window_modes": list(BADGE_WINDOW_MODES),
        "glass_enabled": get_glass_enabled(db_path),
        "glass_opacity": get_glass_opacity(db_path),
        "limits_enabled": get_limits_enabled(db_path),
    })


def _window_payload(used: int, cap):
    """Shape one limit window for the frontend."""
    if cap is None or cap <= 0:
        return {"used": used, "cap": None, "remaining": None, "pct_used": None, "pct_remaining": None}
    pct_used = min(1.0, used / cap)
    return {
        "used": used,
        "cap": cap,
        "remaining": max(0, cap - used),
        "pct_used": round(pct_used, 4),
        "pct_remaining": round(1.0 - pct_used, 4),
    }


def _api_limits(handler, db_path, pricing, qs):
    """Token budget remaining in the active 5h session and rolling 7d window.

    The 5h window is anchored at the first assistant message of the current
    session (matching how Anthropic enforces the limit), not a rolling
    `now-5h` slice — otherwise tokens from a previous session that ended
    hours ago would drag the remaining % down.

    Caps are approximate — Anthropic doesn't publish concrete token quotas,
    so these are rough community estimates per plan. Users on the API plan
    get null caps (unlimited)."""
    plan = get_plan(db_path)
    caps = (pricing.get("limits") or {}).get(plan) or {"five_hour": None, "weekly": None}
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat().replace("+00:00", "Z")
    since_week = (now - timedelta(days=7)).isoformat().replace("+00:00", "Z")
    used_week = window_billable_tokens(db_path, since_week, pricing)

    anchor_iso = current_session_anchor(db_path, now_iso)
    if anchor_iso is None:
        used_5h = 0
        resets_at_iso = None
    else:
        used_5h = window_billable_tokens(db_path, anchor_iso, pricing)
        anchor_dt = datetime.fromisoformat(anchor_iso.replace("Z", "+00:00"))
        resets_at_iso = (anchor_dt + timedelta(hours=SESSION_HOURS)).isoformat().replace("+00:00", "Z")

    five_hour = _window_payload(used_5h, caps.get("five_hour"))
    five_hour["anchor"] = anchor_iso
    five_hour["resets_at"] = resets_at_iso
    send_json(handler, {
        "plan": plan,
        "approximate": True,
        "meta": pricing.get("limits_meta") or {},
        "five_hour": five_hour,
        "weekly": _window_payload(used_week, caps.get("weekly")),
    })


def _api_health(handler, db_path, pricing, qs):
    """Cheap liveness/readiness probe. Used by Electron to detect ready-state."""
    now = time.time()
    send_json(handler, {
        "ok": True,
        "version": _VERSION,
        "started_at": _STARTED_AT,
        "uptime_s": (now - _STARTED_AT) if _STARTED_AT else None,
        "now": now,
        "scan_interval_s": float(os.environ.get("TOKEN_DASHBOARD_SCAN_INTERVAL", "5.0") or 5.0),
        "projects_dir": getattr(handler.__class__, "_td_projects_dir", None),
        "db": getattr(handler.__class__, "_td_db_path", None),
        "sse_clients": EVENTS.subscriber_count(),
    })


GET_ROUTES = {
    "/api/overview":  _api_overview,
    "/api/prompts":   _api_prompts,
    "/api/projects":  _api_projects,
    "/api/tools":     _api_tools,
    "/api/sessions":  _api_sessions,
    "/api/daily":     _api_daily,
    "/api/hourly":    _api_hourly,
    "/api/skills":    _api_skills,
    "/api/by-model":  _api_by_model,
    "/api/tips":      _api_tips,
    "/api/plan":      _api_plan,
    "/api/preferences": _api_preferences,
    "/api/limits":    _api_limits,
    "/api/health":    _api_health,
    "/api/tags":      _api_tags,
    "/api/budget":    _api_budget,
    "/api/phase-split": _api_phase_split,
    "/api/export.csv": _api_export_csv,
    "/api/export.db":  _api_export_db,
    "/api/sources":   _api_sources_list,
}


def _normalise_tag(raw: str) -> str:
    """Strip whitespace, collapse internal spaces, cap at 64 chars."""
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())[:64]


def build_handler(db_path: str, projects_dir: str):
    pricing_cache = _PricingCache()

    class H(http.server.BaseHTTPRequestHandler):
        _td_db_path = db_path
        _td_projects_dir = projects_dir

        def log_message(self, fmt, *args):
            pass

        def do_HEAD(self):
            return self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query or "")
            path = url.path

            if path in ("/", "/index.html"):
                return serve_static(self, "index.html")
            if path.startswith("/web/"):
                return serve_static(self, path[5:])
            if path == "/api/stream":
                return sse_stream(self)
            if path == "/api/scan":
                return send_json(self, scan_dir(projects_dir, db_path))
            if path.startswith("/api/sessions/"):
                # /api/sessions/<sid>           → session turns
                # /api/sessions/<sid>/tags      → that session's tags only
                rest = path[len("/api/sessions/"):]
                parts = rest.split("/")
                sid = parts[0]
                if len(parts) == 2 and parts[1] == "tags":
                    from ..db import session_tags as _st
                    return send_json(self, {"tags": _st(db_path, [sid]).get(sid, [])})
                return send_json(self, session_turns(db_path, sid))

            handler_fn = GET_ROUTES.get(path)
            if handler_fn is not None:
                return handler_fn(self, db_path, pricing_cache.get(), qs)

            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            url = urlparse(self.path)
            # Binary upload bypasses the JSON parser (a 100MB DB blob would
            # otherwise be read into memory and re-parsed as JSON, failing).
            if url.path == "/api/import.db":
                return _api_import_db(self, db_path)
            if url.path == "/api/sources/add":
                return _api_sources_add(self, db_path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return send_error_json(self, 400, "invalid Content-Length")
            if length < 0 or length > MAX_POST_BYTES:
                return send_error_json(
                    self, 413, f"body too large (max {MAX_POST_BYTES} bytes)")
            try:
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except json.JSONDecodeError:
                return send_error_json(self, 400, "invalid JSON")
            if not isinstance(body, dict):
                return send_error_json(self, 400, "body must be a JSON object")
            if url.path == "/api/plan":
                set_plan(db_path, body.get("plan", "api"))
                return send_json(self, {"ok": True})
            if url.path == "/api/preferences":
                resp = {"ok": True}
                if "badge_metric" in body:
                    metric = set_badge_metric(db_path, body.get("badge_metric", ""))
                    EVENTS.publish({"type": "preferences", "badge_metric": metric})
                    resp["badge_metric"] = metric
                if "glass_enabled" in body:
                    glass = set_glass_enabled(db_path, bool(body.get("glass_enabled")))
                    EVENTS.publish({"type": "preferences", "glass_enabled": glass})
                    resp["glass_enabled"] = glass
                if "glass_opacity" in body:
                    op = set_glass_opacity(db_path, body.get("glass_opacity"))
                    EVENTS.publish({"type": "preferences", "glass_opacity": op})
                    resp["glass_opacity"] = op
                if "badge_dock_enabled" in body:
                    v = set_badge_dock_enabled(db_path, bool(body.get("badge_dock_enabled")))
                    EVENTS.publish({"type": "preferences", "badge_dock_enabled": v})
                    resp["badge_dock_enabled"] = v
                if "badge_menubar_enabled" in body:
                    v = set_badge_menubar_enabled(db_path, bool(body.get("badge_menubar_enabled")))
                    EVENTS.publish({"type": "preferences", "badge_menubar_enabled": v})
                    resp["badge_menubar_enabled"] = v
                if "badge_window_mode" in body:
                    mode = set_badge_window_mode(db_path, body.get("badge_window_mode", ""))
                    EVENTS.publish({"type": "preferences", "badge_window_mode": mode})
                    resp["badge_window_mode"] = mode
                if "limits_enabled" in body:
                    v = set_limits_enabled(db_path, bool(body.get("limits_enabled")))
                    EVENTS.publish({"type": "preferences", "limits_enabled": v})
                    resp["limits_enabled"] = v
                return send_json(self, resp)
            if url.path == "/api/tips/dismiss":
                dismiss_tip(db_path, body.get("key", ""))
                return send_json(self, {"ok": True})
            if url.path.startswith("/api/sources/"):
                rest = url.path[len("/api/sources/"):]
                if rest.endswith("/toggle"):
                    name = rest[:-len("/toggle")]
                    if not name:
                        return send_error_json(self, 400, "missing source name")
                    return _api_sources_toggle(self, db_path, name, body)
                if rest.endswith("/delete"):
                    name = rest[:-len("/delete")]
                    if not name:
                        return send_error_json(self, 400, "missing source name")
                    return _api_sources_delete(self, db_path, name)
            if url.path == "/api/budget":
                resp: dict = {"ok": True}
                key_map = {
                    "daily":   "budget_daily_usd",
                    "weekly":  "budget_weekly_usd",
                    "monthly": "budget_monthly_usd",
                }
                for short, long_key in key_map.items():
                    if short in body:
                        v = set_budget(db_path, long_key, body[short])
                        resp[short] = v
                return send_json(self, resp)
            if url.path.startswith("/api/sessions/") and url.path.endswith("/tags"):
                sid = url.path[len("/api/sessions/"):-len("/tags")]
                if not sid:
                    return send_error_json(self, 400, "missing session id")
                added, removed = [], []
                for raw in body.get("add", []) or []:
                    t = _normalise_tag(raw)
                    if t:
                        add_session_tag(db_path, sid, t)
                        added.append(t)
                for raw in body.get("remove", []) or []:
                    t = _normalise_tag(raw)
                    if t:
                        remove_session_tag(db_path, sid, t)
                        removed.append(t)
                from ..db import session_tags as _st
                return send_json(self, {
                    "ok": True,
                    "added": added,
                    "removed": removed,
                    "tags": _st(db_path, [sid]).get(sid, []),
                })
            self.send_response(404)
            self.end_headers()

    return H
