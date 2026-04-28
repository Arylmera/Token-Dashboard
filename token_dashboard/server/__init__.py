"""Public surface for the server subpackage. Mirrors the old `token_dashboard.server` module."""
from .routes import build_handler
from .scan_loop import run
from .sse import EVENTS

__all__ = ["EVENTS", "build_handler", "run"]
