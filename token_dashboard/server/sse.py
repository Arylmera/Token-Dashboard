"""Server-Sent Events: shared event queue + the long-lived stream loop."""
from __future__ import annotations

import json
import queue
import threading
import time

EVENTS: "queue.Queue[dict]" = queue.Queue()

_lock = threading.Lock()
_active = 0
_ever_connected = False
_last_disconnect_ts: float | None = None


def active_clients() -> int:
    with _lock:
        return _active


def ever_connected() -> bool:
    with _lock:
        return _ever_connected


def last_disconnect_ts() -> float | None:
    with _lock:
        return _last_disconnect_ts


def stream(handler) -> None:
    """Keep the connection open, ship events as they arrive, ping every 15s."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "keep-alive")
    handler.end_headers()
    global _active, _ever_connected, _last_disconnect_ts
    with _lock:
        _active += 1
        _ever_connected = True
    try:
        while True:
            try:
                evt = EVENTS.get(timeout=15)
                chunk = f"data: {json.dumps(evt, default=str)}\n\n".encode()
            except queue.Empty:
                chunk = b": ping\n\n"
            try:
                handler.wfile.write(chunk)
                handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
    finally:
        with _lock:
            _active -= 1
            if _active <= 0:
                _last_disconnect_ts = time.time()
