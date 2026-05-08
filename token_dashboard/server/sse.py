"""Server-Sent Events: per-client fan-out hub + the long-lived stream loop.

Each connected client gets its own bounded `queue.Queue`; `publish()` enqueues
the event on every subscriber. This replaces the prior single-global-queue
design where multiple clients (e.g. main window + tray) would steal events
from each other.
"""
from __future__ import annotations

import json
import os
import queue
import threading

_DEFAULT_KEEPALIVE = 15.0
_DEFAULT_QUEUE_SIZE = 64


def _resolve_keepalive() -> float:
    raw = os.environ.get("TOKEN_DASHBOARD_SSE_KEEPALIVE")
    if not raw:
        return _DEFAULT_KEEPALIVE
    try:
        return max(1.0, float(raw))
    except ValueError:
        return _DEFAULT_KEEPALIVE


class Hub:
    """Thread-safe pub/sub: one queue per subscriber, broadcast on publish."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: list[queue.Queue] = []

    def subscribe(self, maxsize: int = _DEFAULT_QUEUE_SIZE) -> "queue.Queue":
        q: queue.Queue = queue.Queue(maxsize=maxsize)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue") -> None:
        with self._lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                # Drop oldest to keep the stream live for slow clients.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)


EVENTS = Hub()


def stream(handler) -> None:
    """Keep the connection open, ship events as they arrive, ping periodically."""
    keepalive = _resolve_keepalive()
    q = EVENTS.subscribe()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()
    try:
        while True:
            try:
                evt = q.get(timeout=keepalive)
                chunk = f"data: {json.dumps(evt, default=str)}\n\n".encode()
            except queue.Empty:
                chunk = b": ping\n\n"
            try:
                handler.wfile.write(chunk)
                handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
    finally:
        EVENTS.unsubscribe(q)
