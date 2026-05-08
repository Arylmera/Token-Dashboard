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

from ..db import (
    daily_token_breakdown,
    expensive_prompts,
    hourly_breakdown,
    model_breakdown,
    overview_totals,
    project_summary,
    recent_sessions,
    session_turns,
    skill_breakdown,
    tool_token_breakdown,
)
from ..pricing import cost_for, get_plan, load_pricing, set_plan
from ..scanner import scan_dir
from ..skills import cached_catalog
from ..tips import all_tips, dismiss_tip
from .http_utils import (
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
    send_json(handler, recent_sessions(
        db_path,
        limit=clamp_limit(qs.get("limit", ["20"])[0], 20),
        since=qs.get("since", [None])[0],
        until=qs.get("until", [None])[0],
        pricing=pricing,
    ))


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
    "/api/health":    _api_health,
}


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
                sid = path.rsplit("/", 1)[1]
                return send_json(self, session_turns(db_path, sid))

            handler_fn = GET_ROUTES.get(path)
            if handler_fn is not None:
                return handler_fn(self, db_path, pricing_cache.get(), qs)

            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            url = urlparse(self.path)
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
            if url.path == "/api/tips/dismiss":
                dismiss_tip(db_path, body.get("key", ""))
                return send_json(self, {"ok": True})
            self.send_response(404)
            self.end_headers()

    return H
