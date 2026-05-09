"""Budget cap reporting: spend-to-date vs. configured caps with linear projection."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ...db import model_breakdown
from ...preferences import get_budgets
from ...pricing import cost_for
from ..http_utils import send_json


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


def budget(handler, db_path, pricing, qs):
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
