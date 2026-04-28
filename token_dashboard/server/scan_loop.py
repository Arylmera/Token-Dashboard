"""Background JSONL scan loop + the public `run` entry point."""
from __future__ import annotations

import http.server
import os
import threading
import time

from ..scanner import scan_dir
from .routes import build_handler
from .sse import EVENTS

DEFAULT_SCAN_INTERVAL = 5.0


def _resolve_scan_interval() -> float:
    raw = os.environ.get("TOKEN_DASHBOARD_SCAN_INTERVAL")
    if not raw:
        return DEFAULT_SCAN_INTERVAL
    try:
        v = float(raw)
    except ValueError:
        return DEFAULT_SCAN_INTERVAL
    # Clamp to a sane floor so we don't hammer the disk if someone sets 0.
    return max(0.5, v)


def _scan_loop(db_path: str, projects_dir: str, interval: float = DEFAULT_SCAN_INTERVAL):
    while True:
        try:
            n = scan_dir(projects_dir, db_path)
            if n["messages"] > 0:
                EVENTS.put({"type": "scan", "n": n, "ts": time.time()})
        except Exception as e:
            EVENTS.put({"type": "error", "message": str(e)})
        time.sleep(interval)


def run(host: str, port: int, db_path: str, projects_dir: str):
    interval = _resolve_scan_interval()
    threading.Thread(
        target=_scan_loop, args=(db_path, projects_dir, interval), daemon=True
    ).start()
    H = build_handler(db_path, projects_dir)
    httpd = http.server.ThreadingHTTPServer((host, port), H)
    httpd.serve_forever()
