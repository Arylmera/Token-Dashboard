"""Attached external SQLite source registry: list / add / toggle / delete."""
from __future__ import annotations

import time

from ...db.sources import (
    add_source,
    list_sources,
    remove_source,
    set_source_enabled,
)
from ..http_utils import MAX_IMPORT_BYTES, send_error_json, send_json
from ..sse import EVENTS


def sources_list(handler, db_path, pricing, qs):
    send_json(handler, list_sources(db_path))


def sources_add(handler, db_path) -> None:
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


def sources_toggle(handler, db_path, name: str, body: dict) -> None:
    if not set_source_enabled(db_path, name, bool(body.get("enabled"))):
        return send_error_json(handler, 404, "source not found")
    EVENTS.publish({"type": "sources"})
    send_json(handler, {"ok": True, "name": name, "enabled": bool(body.get("enabled"))})


def sources_delete(handler, db_path, name: str) -> None:
    if not remove_source(db_path, name):
        return send_error_json(handler, 404, "source not found")
    EVENTS.publish({"type": "sources"})
    send_json(handler, {"ok": True, "name": name})
