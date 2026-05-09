"""Pricing endpoints — view defaults/overrides/effective rates and edit overrides."""
from __future__ import annotations

import copy

from ...pricing import (
    PRICING_FIELDS,
    apply_pricing_overrides,
    clear_all_pricing_overrides,
    clear_pricing_override,
    get_pricing_overrides,
    set_pricing_override,
)
from ..http_utils import send_error_json, send_json
from .state import PricingCache


def _payload(defaults: dict, overrides: dict) -> dict:
    effective_full = apply_pricing_overrides(defaults, overrides)
    return {
        "defaults": copy.deepcopy(defaults.get("models") or {}),
        "overrides": overrides,
        "effective": effective_full.get("models") or {},
    }


def pricing_get(handler, db_path, pricing, qs, *, cache: PricingCache) -> None:
    defaults = cache.defaults()
    overrides = get_pricing_overrides(db_path)
    send_json(handler, _payload(defaults, overrides))


def pricing_set(handler, db_path, model: str, body: dict, *, cache: PricingCache) -> None:
    defaults = cache.defaults()
    if model not in (defaults.get("models") or {}):
        return send_error_json(handler, 404, f"unknown model: {model}")
    cleaned: dict = {}
    for k in PRICING_FIELDS:
        if k not in body:
            continue
        try:
            v = float(body[k])
        except (TypeError, ValueError):
            return send_error_json(handler, 400, f"invalid value for {k}")
        if v < 0:
            return send_error_json(handler, 400, f"{k} must be >= 0")
        cleaned[k] = v
    if not cleaned:
        return send_error_json(handler, 400, "no pricing fields supplied")
    set_pricing_override(db_path, model, cleaned)
    overrides = get_pricing_overrides(db_path)
    send_json(handler, _payload(defaults, overrides))


def pricing_clear(handler, db_path, model: str, *, cache: PricingCache) -> None:
    defaults = cache.defaults()
    if model not in (defaults.get("models") or {}):
        return send_error_json(handler, 404, f"unknown model: {model}")
    clear_pricing_override(db_path, model)
    overrides = get_pricing_overrides(db_path)
    send_json(handler, _payload(defaults, overrides))


def pricing_clear_all(handler, db_path, *, cache: PricingCache) -> None:
    defaults = cache.defaults()
    clear_all_pricing_overrides(db_path)
    send_json(handler, _payload(defaults, {}))
