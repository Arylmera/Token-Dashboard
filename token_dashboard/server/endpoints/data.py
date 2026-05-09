"""Read-only data endpoints: overview, prompts, sessions, charts, limits, etc."""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone

from ...db import (
    EXECUTE_TOOLS,
    PLAN_TOOLS,
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
    skill_breakdown,
    tool_token_breakdown,
    window_billable_tokens,
)
from ...preferences import (
    BADGE_METRICS,
    BADGE_WINDOW_MODES,
    get_anthropic_api_key,
    get_badge_dock_enabled,
    get_badge_menubar_enabled,
    get_badge_metric,
    get_badge_window_mode,
    get_glass_enabled,
    get_glass_opacity,
    get_limit_cap_override,
    get_limit_reset_at,
    get_limits_enabled,
    get_limits_sync_meta,
    set_limit_reset_at,
)
from ...pricing import cost_for, get_plan
from ...skills import cached_catalog
from ...tips import all_tips
from ..http_utils import clamp_limit, send_json
from ..sse import EVENTS
from .state import VERSION, get_started_at


def overview(handler, db_path, pricing, qs):
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


def prompts(handler, db_path, pricing, qs):
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


def projects(handler, db_path, pricing, qs):
    send_json(handler, project_summary(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def tools(handler, db_path, pricing, qs):
    send_json(handler, tool_token_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def sessions(handler, db_path, pricing, qs):
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


def tags(handler, db_path, pricing, qs):
    send_json(handler, all_tags(db_path))


def phase_split_endpoint(handler, db_path, pricing, qs):
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


def daily(handler, db_path, pricing, qs):
    send_json(handler, daily_token_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0]))


def hourly(handler, db_path, pricing, qs):
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


def skills(handler, db_path, pricing, qs):
    rows = skill_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0])
    catalog = cached_catalog()
    # Skill definitions are loaded into the system prompt via system-reminder.
    # We can't observe them directly, so we estimate: per session the def is
    # written to cache once (cache_create_5m) then read on each subsequent
    # invocation in that session (cache_read). Sonnet rates are used as a
    # tier-neutral default since skills aren't tied to a specific model.
    sonnet = (pricing.get("tier_fallback") or {}).get("sonnet") or {}
    rate_create = float(sonnet.get("cache_create_5m") or 0.0) / 1_000_000.0
    rate_read = float(sonnet.get("cache_read") or 0.0) / 1_000_000.0
    for r in rows:
        info = catalog.get(r["skill"])
        tpc = info["tokens"] if info else None
        r["tokens_per_call"] = tpc
        if tpc:
            invocations = int(r.get("invocations") or 0)
            sessions = int(r.get("sessions") or 0)
            extra = max(0, invocations - sessions)
            r["est_tokens"] = invocations * tpc
            r["est_cost_usd"] = round(
                sessions * tpc * rate_create + extra * tpc * rate_read, 6
            )
        else:
            r["est_tokens"] = None
            r["est_cost_usd"] = None
        r["estimated"] = True
    send_json(handler, rows)


def by_model(handler, db_path, pricing, qs):
    rows = model_breakdown(
        db_path, qs.get("since", [None])[0], qs.get("until", [None])[0])
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        r["cost_usd"] = c["usd"]
        r["cost_estimated"] = c["estimated"]
    send_json(handler, rows)


def tips(handler, db_path, pricing, qs):
    send_json(handler, all_tips(db_path))


def plan(handler, db_path, pricing, qs):
    send_json(handler, {"plan": get_plan(db_path), "pricing": pricing})


def preferences(handler, db_path, pricing, qs):
    _meta = get_limits_sync_meta(db_path)
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
        "limits_five_hour_reset_at": get_limit_reset_at(db_path, "limits_five_hour_reset_at"),
        "limits_weekly_reset_at":    get_limit_reset_at(db_path, "limits_weekly_reset_at"),
        "limits_5h_cap_override":     get_limit_cap_override(db_path, "limits_5h_cap_override"),
        "limits_weekly_cap_override": get_limit_cap_override(db_path, "limits_weekly_cap_override"),
        "anthropic_api_key_set":     get_anthropic_api_key(db_path) is not None,
        "limits_last_sync_at":       _meta["last_sync_at"],
        "limits_last_sync_status":   _meta["last_sync_status"],
    })


_FIVE_H = timedelta(hours=5)
_SEVEN_D = timedelta(days=7)


def _roll_forward(reset_dt: datetime, now: datetime, period: timedelta) -> datetime:
    while reset_dt <= now:
        reset_dt += period
    return reset_dt


def _resolve_override(db_path, key: str, now: datetime, period: timedelta):
    raw = get_limit_reset_at(db_path, key)
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    rolled = _roll_forward(dt, now, period)
    rolled_iso = rolled.isoformat().replace("+00:00", "Z")
    if rolled_iso != raw:
        set_limit_reset_at(db_path, key, rolled_iso)
    return rolled


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


def limits(handler, db_path, pricing, qs):
    """Token budget remaining in the active 5h session and rolling 7d window.

    The 5h window is anchored at the first assistant message of the current
    session (matching how Anthropic enforces the limit), not a rolling
    `now-5h` slice — otherwise tokens from a previous session that ended
    hours ago would drag the remaining % down.

    If the user has set a manual override for either window (via
    /api/preferences or synced from Anthropic), that override is used as the
    reset anchor and is automatically rolled forward if it has passed.

    Caps are approximate — Anthropic doesn't publish concrete token quotas,
    so these are rough community estimates per plan. Users on the API plan
    get null caps (unlimited)."""
    plan_id = get_plan(db_path)
    caps = (pricing.get("limits") or {}).get(plan_id) or {"five_hour": None, "weekly": None}
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat().replace("+00:00", "Z")

    override_5h = _resolve_override(db_path, "limits_five_hour_reset_at", now, _FIVE_H)
    if override_5h is not None:
        anchor_dt = override_5h - _FIVE_H
        anchor_iso = anchor_dt.isoformat().replace("+00:00", "Z")
        used_5h = window_billable_tokens(db_path, anchor_iso, pricing)
        resets_at_iso = override_5h.isoformat().replace("+00:00", "Z")
    else:
        anchor_iso = current_session_anchor(db_path, now_iso)
        if anchor_iso is None:
            used_5h = 0
            resets_at_iso = None
        else:
            used_5h = window_billable_tokens(db_path, anchor_iso, pricing)
            anchor_dt = datetime.fromisoformat(anchor_iso.replace("Z", "+00:00"))
            resets_at_iso = (anchor_dt + _FIVE_H).isoformat().replace("+00:00", "Z")

    override_5h_cap = get_limit_cap_override(db_path, "limits_5h_cap_override")
    cap_5h = override_5h_cap if override_5h_cap is not None else caps.get("five_hour")
    five_hour = _window_payload(used_5h, cap_5h)
    five_hour["anchor"] = anchor_iso
    five_hour["resets_at"] = resets_at_iso
    five_hour["calibrated"] = override_5h_cap is not None

    override_week = _resolve_override(db_path, "limits_weekly_reset_at", now, _SEVEN_D)
    if override_week is not None:
        since_week = (override_week - _SEVEN_D).isoformat().replace("+00:00", "Z")
        weekly_resets_at = override_week.isoformat().replace("+00:00", "Z")
    else:
        since_week = (now - _SEVEN_D).isoformat().replace("+00:00", "Z")
        weekly_resets_at = None

    used_week = window_billable_tokens(db_path, since_week, pricing)
    override_weekly_cap = get_limit_cap_override(db_path, "limits_weekly_cap_override")
    cap_weekly = override_weekly_cap if override_weekly_cap is not None else caps.get("weekly")
    weekly = _window_payload(used_week, cap_weekly)
    weekly["resets_at"] = weekly_resets_at
    weekly["calibrated"] = override_weekly_cap is not None

    send_json(handler, {
        "plan": plan_id,
        "approximate": True,
        "meta": pricing.get("limits_meta") or {},
        "five_hour": five_hour,
        "weekly": weekly,
    })


def health(handler, db_path, pricing, qs):
    """Cheap liveness/readiness probe. Used by Electron to detect ready-state."""
    now = time.time()
    started_at = get_started_at()
    send_json(handler, {
        "ok": True,
        "version": VERSION,
        "started_at": started_at,
        "uptime_s": (now - started_at) if started_at else None,
        "now": now,
        "scan_interval_s": float(os.environ.get("TOKEN_DASHBOARD_SCAN_INTERVAL", "5.0") or 5.0),
        "projects_dir": getattr(handler.__class__, "_td_projects_dir", None),
        "db": getattr(handler.__class__, "_td_db_path", None),
        "sse_clients": EVENTS.subscriber_count(),
    })
