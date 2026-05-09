"""Process-wide state shared across endpoints: server start time, version,
and the pricing-file cache."""
from __future__ import annotations

from pathlib import Path

from ...pricing import load_pricing
from ..http_utils import pricing_path

_STARTED_AT: float | None = None


def set_started_at(ts: float) -> None:
    """Called by scan_loop.run after the listening socket is bound."""
    global _STARTED_AT
    _STARTED_AT = ts


def get_started_at() -> "float | None":
    return _STARTED_AT


def _read_version() -> str:
    here = Path(__file__).resolve().parent.parent.parent.parent
    candidates = [here / "VERSION", Path(__file__).resolve().parent.parent.parent / "VERSION"]
    for p in candidates:
        try:
            return p.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return "0.0.0"


VERSION = _read_version()


class PricingCache:
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
