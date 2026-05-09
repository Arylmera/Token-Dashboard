"""Background JSONL scan loop + the public `run` entry point."""
from __future__ import annotations

import http.server
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

from ..scanner import scan_dir
from .routes import build_handler, set_started_at
from .sse import EVENTS, active_clients, ever_connected, last_disconnect_ts

DEFAULT_SCAN_INTERVAL = 5.0
AUTO_EXIT_IDLE_SECONDS = 8.0
READY_TOKEN = "TOKEN_DASHBOARD_READY"
BUNDLE_POLL_INTERVAL = 0.5


def _bundle_watch_loop():
    """Dev-only: watch frontend/dist/app.js mtime, publish SSE on change."""
    bundle = Path(__file__).resolve().parents[2] / "frontend" / "dist" / "app.js"
    last: float | None = None
    try:
        last = bundle.stat().st_mtime
    except OSError:
        last = None
    while True:
        time.sleep(BUNDLE_POLL_INTERVAL)
        try:
            cur = bundle.stat().st_mtime
        except OSError:
            continue
        if last is None:
            last = cur
            continue
        if cur != last:
            last = cur
            EVENTS.publish({"type": "bundle", "ts": time.time()})


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
                EVENTS.publish({
                    "type": "scan",
                    "n": {"messages": n["messages"]},  # back-compat for tray client
                    "changed": {
                        "sessions": n.get("sessions") or [],
                        "projects": n.get("projects") or [],
                        "days":     n.get("days") or [],
                        "models":   n.get("models") or [],
                        "min_ts":   n.get("min_ts"),
                        "max_ts":   n.get("max_ts"),
                    },
                    "ts": time.time(),
                })
        except Exception as e:
            EVENTS.publish({"type": "error", "message": str(e)})
        time.sleep(interval)


def _emit_ready(host: str, port: int, db_path: str, projects_dir: str) -> None:
    """Print a structured ready line so a parent process (e.g. Electron) can
    detect bound state without polling. Format:

        TOKEN_DASHBOARD_READY {"url": "...", "pid": ..., "host": "...", "port": ...}
    """
    payload = {
        "url": f"http://{host}:{port}/",
        "host": host,
        "port": port,
        "pid": os.getpid(),
        "db": db_path,
        "projects_dir": projects_dir,
        "ts": time.time(),
    }
    try:
        line = f"{READY_TOKEN} {json.dumps(payload)}"
        print(line, flush=True)
    except Exception:
        # Best-effort: never let logging fail server startup.
        pass


def _auto_exit_watcher(httpd, idle_seconds: float):
    """Shut the server down once all SSE clients have disconnected and stayed gone."""
    while True:
        time.sleep(1.0)
        if not ever_connected():
            continue
        if active_clients() > 0:
            continue
        ts = last_disconnect_ts()
        if ts is None:
            continue
        if (time.time() - ts) >= idle_seconds:
            threading.Thread(target=httpd.shutdown, daemon=True).start()
            return


def run(host: str, port: int, db_path: str, projects_dir: str, auto_exit: bool = False):
    interval = _resolve_scan_interval()
    threading.Thread(
        target=_scan_loop, args=(db_path, projects_dir, interval), daemon=True
    ).start()
    if os.environ.get("TOKEN_DASHBOARD_DEV") == "1":
        threading.Thread(target=_bundle_watch_loop, daemon=True).start()
    H = build_handler(db_path, projects_dir)
    set_started_at(time.time())
    try:
        httpd = http.server.ThreadingHTTPServer((host, port), H)
    except OSError as e:
        # 10048 (Windows) / 48 (macOS) / 98 (Linux) all surface as EADDRINUSE.
        in_use = getattr(e, "errno", None) in (48, 98) or "address already in use" in str(e).lower() or "10048" in str(e)
        if in_use:
            sys.stderr.write(
                f"Token Dashboard: port {port} on {host} is already in use. "
                f"Set PORT=<free port> and retry.\n"
            )
            sys.exit(2)
        raise
    if auto_exit:
        threading.Thread(
            target=_auto_exit_watcher, args=(httpd, AUTO_EXIT_IDLE_SECONDS), daemon=True
        ).start()
    _emit_ready(host, port, db_path, projects_dir)
    httpd.serve_forever()


def free_port(host: str = "127.0.0.1") -> int:
    """Probe a free TCP port. Useful for tests / Electron handshake."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]
