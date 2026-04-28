"""Server-Sent Events: shared event queue + the long-lived stream loop."""
from __future__ import annotations

import json
import queue

EVENTS: "queue.Queue[dict]" = queue.Queue()


def stream(handler) -> None:
    """Keep the connection open, ship events as they arrive, ping every 15s."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "keep-alive")
    handler.end_headers()
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
