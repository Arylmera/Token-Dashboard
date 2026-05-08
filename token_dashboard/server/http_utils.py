"""Tiny helpers for the BaseHTTPRequestHandler — JSON, errors, static files."""
from __future__ import annotations

import json
import mimetypes
import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    _PKG_ROOT = Path(sys._MEIPASS) / "token_dashboard"
    _REPO_ROOT = Path(sys._MEIPASS)
else:
    _PKG_ROOT = Path(__file__).resolve().parent.parent
    _REPO_ROOT = _PKG_ROOT.parent

# Resolve frontend asset root in priority order:
#   1. Repo / frozen-bundle layout: `<root>/frontend/`
#   2. Wheel-installed layout (hatch force-include): `<pkg>/_frontend/`
# The first candidate that exists wins; falls back to the first if neither
# exists yet (so import time never fails).
_WEB_CANDIDATES = (_REPO_ROOT / "frontend", _PKG_ROOT / "_frontend")
WEB_ROOT = next((p for p in _WEB_CANDIDATES if p.exists()), _WEB_CANDIDATES[0])
PACKAGED_PRICING_JSON = _PKG_ROOT / "pricing.json"


def pricing_path() -> Path:
    override = os.environ.get("TOKEN_DASHBOARD_PRICING")
    if override:
        return Path(override)
    return PACKAGED_PRICING_JSON

def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        return default
    return v if v > 0 else default


MAX_POST_BYTES = _env_int("TOKEN_DASHBOARD_MAX_POST_BYTES", 1_000_000)  # JSON-only POSTs
MAX_LIMIT = _env_int("TOKEN_DASHBOARD_MAX_LIMIT", 1000)


def send_json(handler, obj, status: int = 200) -> None:
    body = json.dumps(obj, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def send_error_json(handler, status: int, msg: str) -> None:
    send_json(handler, {"error": msg}, status=status)


def clamp_limit(raw, default: int) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(v, MAX_LIMIT))


def serve_static(handler, rel: str) -> None:
    rel = rel.lstrip("/")
    p = (WEB_ROOT / rel).resolve()
    if not str(p).startswith(str(WEB_ROOT.resolve())) or not p.is_file():
        handler.send_response(404)
        handler.end_headers()
        return
    body = p.read_bytes()
    ctype, _ = mimetypes.guess_type(str(p))
    handler.send_response(200)
    handler.send_header("Content-Type", ctype or "application/octet-stream")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)
