"""HTTP routing: build_handler returns the BaseHTTPRequestHandler subclass.

Endpoint functions live in `endpoints/` (state, data, budget, sources, io);
this module wires them into the dispatch tables and handles request parsing.
"""
from __future__ import annotations

import http.server
import json
from urllib.parse import parse_qs, urlparse

from ..scanner import scan_dir
from ..pricing import set_plan
from ..preferences import set_budget
from ..tips import dismiss_tip
from ..db import add_session_tag, remove_session_tag
from ..preferences import (
    set_badge_dock_enabled,
    set_badge_menubar_enabled,
    set_badge_metric,
    set_badge_window_mode,
    set_glass_enabled,
    set_glass_opacity,
    set_limits_enabled,
)
from .http_utils import (
    MAX_POST_BYTES,
    send_error_json,
    send_json,
    serve_static,
)
from .sse import EVENTS
from .sse import stream as sse_stream
from .endpoints import (
    data,
    budget as budget_ep,
    sources as sources_ep,
    io as io_ep,
    pricing as pricing_ep,
)
from .endpoints.state import PricingCache, set_started_at  # noqa: F401  re-export

# Imports inside route handlers (db.session_tags) are deferred to avoid a
# circular at module-load time.
from ..db import session_tags as _session_tags

GET_ROUTES = {
    "/api/overview":    data.overview,
    "/api/prompts":     data.prompts,
    "/api/projects":    data.projects,
    "/api/tools":       data.tools,
    "/api/sessions":    data.sessions,
    "/api/daily":       data.daily,
    "/api/hourly":      data.hourly,
    "/api/skills":      data.skills,
    "/api/by-model":    data.by_model,
    "/api/tips":        data.tips,
    "/api/plan":        data.plan,
    "/api/preferences": data.preferences,
    "/api/limits":      data.limits,
    "/api/health":      data.health,
    "/api/tags":        data.tags,
    "/api/phase-split": data.phase_split_endpoint,
    "/api/budget":      budget_ep.budget,
    "/api/export.csv":  io_ep.export_csv,
    "/api/export.db":   io_ep.export_db,
    "/api/sources":     sources_ep.sources_list,
}


def _normalise_tag(raw: str) -> str:
    """Strip whitespace, collapse internal spaces, cap at 64 chars."""
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())[:64]


def build_handler(db_path: str, projects_dir: str):
    pricing_cache = PricingCache(db_path)

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
            if path == "/api/pricing":
                return pricing_ep.pricing_get(self, db_path, None, qs, cache=pricing_cache)
            if path.startswith("/api/sessions/"):
                # /api/sessions/<sid>           → session turns
                # /api/sessions/<sid>/tags      → that session's tags only
                rest = path[len("/api/sessions/"):]
                parts = rest.split("/")
                sid = parts[0]
                if len(parts) == 2 and parts[1] == "tags":
                    return send_json(self, {"tags": _session_tags(db_path, [sid]).get(sid, [])})
                from ..db import session_turns
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
                return io_ep.import_db(self, db_path)
            if url.path == "/api/sources/add":
                return sources_ep.sources_add(self, db_path)
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
                    return sources_ep.sources_toggle(self, db_path, name, body)
                if rest.endswith("/delete"):
                    name = rest[:-len("/delete")]
                    if not name:
                        return send_error_json(self, 400, "missing source name")
                    return sources_ep.sources_delete(self, db_path, name)
            if url.path == "/api/pricing/clear-all":
                return pricing_ep.pricing_clear_all(self, db_path, cache=pricing_cache)
            if url.path.startswith("/api/pricing/"):
                rest = url.path[len("/api/pricing/"):]
                if rest.endswith("/clear"):
                    model = rest[:-len("/clear")]
                    if not model:
                        return send_error_json(self, 400, "missing model")
                    return pricing_ep.pricing_clear(self, db_path, model, cache=pricing_cache)
                if rest:
                    return pricing_ep.pricing_set(
                        self, db_path, rest, body, cache=pricing_cache
                    )
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
                return send_json(self, {
                    "ok": True,
                    "added": added,
                    "removed": removed,
                    "tags": _session_tags(db_path, [sid]).get(sid, []),
                })
            self.send_response(404)
            self.end_headers()

    return H
