"""Pricing table + plan-aware cost formatting."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Optional, Union

from .db import connect

_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")

PRICING_FIELDS = ("input", "output", "cache_read", "cache_create_5m", "cache_create_1h")
_PRICING_OVERRIDES_KEY = "pricing_overrides_json"


def _strip_date_suffix(model: str) -> str:
    return _DATE_SUFFIX_RE.sub("", model or "")


def load_pricing(path: Union[str, Path]) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _tier_from_name(model: str) -> Optional[str]:
    m = (model or "").lower()
    for tier in ("opus", "sonnet", "haiku"):
        if tier in m:
            return tier
    return None


def cost_for(model: str, usage: dict, pricing: dict) -> dict:
    """Return {usd, estimated, breakdown}. usd=None when no tier match."""
    rates = pricing["models"].get(model)
    estimated = False
    if rates is None:
        stripped = _strip_date_suffix(model or "")
        if stripped != model:
            rates = pricing["models"].get(stripped)
    if rates is None:
        tier = _tier_from_name(model or "")
        if tier and tier in pricing["tier_fallback"]:
            rates = pricing["tier_fallback"][tier]
            estimated = True
        else:
            return {"usd": None, "estimated": True, "breakdown": {}}
    bd = {
        "input":           usage["input_tokens"]            * rates["input"]           / 1_000_000,
        "output":          usage["output_tokens"]           * rates["output"]          / 1_000_000,
        "cache_read":      usage["cache_read_tokens"]       * rates["cache_read"]      / 1_000_000,
        "cache_create_5m": usage["cache_create_5m_tokens"]  * rates["cache_create_5m"] / 1_000_000,
        "cache_create_1h": usage["cache_create_1h_tokens"]  * rates["cache_create_1h"] / 1_000_000,
    }
    return {"usd": round(sum(bd.values()), 6), "estimated": estimated, "breakdown": bd}


def get_plan(db_path: Union[str, Path], default: str = "api") -> str:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='plan'").fetchone()
    return row["v"] if row else default


def set_plan(db_path: Union[str, Path], plan: str) -> None:
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('plan', ?)", (plan,))
        c.commit()


def get_pricing_overrides(db_path: Union[str, Path]) -> dict:
    """Return the dict of per-model pricing overrides ({} if none)."""
    with connect(db_path) as c:
        row = c.execute(
            "SELECT v FROM plan WHERE k=?", (_PRICING_OVERRIDES_KEY,)
        ).fetchone()
    if not row or not row["v"]:
        return {}
    try:
        data = json.loads(row["v"])
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_pricing_overrides(db_path: Union[str, Path], overrides: dict) -> None:
    payload = json.dumps(overrides, separators=(",", ":"))
    with connect(db_path) as c:
        if overrides:
            c.execute(
                "INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)",
                (_PRICING_OVERRIDES_KEY, payload),
            )
        else:
            c.execute("DELETE FROM plan WHERE k=?", (_PRICING_OVERRIDES_KEY,))
        c.commit()


def set_pricing_override(
    db_path: Union[str, Path], model: str, partial: dict
) -> dict:
    """Merge *partial* into the override row for *model*. Returns the resulting per-model override.

    Skips unknown fields and non-numeric values silently. Negative values must be
    rejected by the caller before invocation; this function does not validate.
    """
    overrides = get_pricing_overrides(db_path)
    current = dict(overrides.get(model) or {})
    for k, v in (partial or {}).items():
        if k not in PRICING_FIELDS:
            continue
        try:
            current[k] = float(v)
        except (TypeError, ValueError):
            continue
    if current:
        overrides[model] = current
    else:
        overrides.pop(model, None)
    _write_pricing_overrides(db_path, overrides)
    return current


def clear_pricing_override(db_path: Union[str, Path], model: str) -> None:
    overrides = get_pricing_overrides(db_path)
    if model in overrides:
        overrides.pop(model, None)
        _write_pricing_overrides(db_path, overrides)


def clear_all_pricing_overrides(db_path: Union[str, Path]) -> None:
    _write_pricing_overrides(db_path, {})


def apply_pricing_overrides(pricing: dict, overrides: dict) -> dict:
    """Return a deep copy of *pricing* with per-model field overrides merged in."""
    if not overrides:
        return pricing
    merged = copy.deepcopy(pricing)
    models = merged.setdefault("models", {})
    for model, fields in overrides.items():
        if model not in models or not isinstance(fields, dict):
            continue
        for k, v in fields.items():
            if k in PRICING_FIELDS and isinstance(v, (int, float)):
                models[model][k] = float(v)
    return merged


def format_for_user(api_cost_usd: float, plan: str, pricing: dict) -> dict:
    p = pricing["plans"].get(plan, pricing["plans"]["api"])
    if plan == "api" or p["monthly"] == 0:
        return {"display_usd": api_cost_usd, "subtitle": None, "subscription_usd": None}
    return {
        "display_usd":      api_cost_usd,
        "subtitle":         f"You pay ${p['monthly']}/mo on {p['label']}",
        "subscription_usd": p["monthly"],
    }
