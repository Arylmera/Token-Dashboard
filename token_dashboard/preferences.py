"""User preferences (key/value, persisted in the existing `plan` table).

Today this stores the `badge_metric` setting that controls what the Electron
tray + dock badge displays. Reuses the `plan` table because it already exists
as a generic k/v store; adding a new table for one-row settings would be
overkill.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Union

from .db import connect

BADGE_METRICS = ("tokens", "cost", "burn", "5h", "weekly")
DEFAULT_BADGE_METRIC = "tokens"

BADGE_WINDOW_MODES = ("remaining", "used")
DEFAULT_BADGE_WINDOW_MODE = "remaining"


def get_badge_window_mode(db_path: Union[str, Path]) -> str:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='badge_window_mode'").fetchone()
    if row and row["v"] in BADGE_WINDOW_MODES:
        return row["v"]
    return DEFAULT_BADGE_WINDOW_MODE


def set_badge_window_mode(db_path: Union[str, Path], mode: str) -> str:
    if mode not in BADGE_WINDOW_MODES:
        mode = DEFAULT_BADGE_WINDOW_MODE
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('badge_window_mode', ?)",
            (mode,),
        )
        c.commit()
    return mode


def get_badge_metric(db_path: Union[str, Path]) -> str:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='badge_metric'").fetchone()
    if row and row["v"] in BADGE_METRICS:
        return row["v"]
    return DEFAULT_BADGE_METRIC


def set_badge_metric(db_path: Union[str, Path], metric: str) -> str:
    if metric not in BADGE_METRICS:
        metric = DEFAULT_BADGE_METRIC
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('badge_metric', ?)",
            (metric,),
        )
        c.commit()
    return metric


def _get_bool(db_path: Union[str, Path], key: str, default: bool) -> bool:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k=?", (key,)).fetchone()
    if not row:
        return default
    return row["v"] == "1"


def _set_bool(db_path: Union[str, Path], key: str, enabled: bool) -> bool:
    val = "1" if enabled else "0"
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)", (key, val))
        c.commit()
    return bool(enabled)


def get_badge_dock_enabled(db_path: Union[str, Path]) -> bool:
    return _get_bool(db_path, "badge_dock_enabled", True)


def set_badge_dock_enabled(db_path: Union[str, Path], enabled: bool) -> bool:
    return _set_bool(db_path, "badge_dock_enabled", enabled)


def get_badge_menubar_enabled(db_path: Union[str, Path]) -> bool:
    return _get_bool(db_path, "badge_menubar_enabled", True)


def set_badge_menubar_enabled(db_path: Union[str, Path], enabled: bool) -> bool:
    return _set_bool(db_path, "badge_menubar_enabled", enabled)


def get_limits_enabled(db_path: Union[str, Path]) -> bool:
    return _get_bool(db_path, "limits_enabled", False)


def set_limits_enabled(db_path: Union[str, Path], enabled: bool) -> bool:
    return _set_bool(db_path, "limits_enabled", enabled)


DEFAULT_GLASS_OPACITY = 25


def get_glass_enabled(db_path: Union[str, Path]) -> bool:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='glass_enabled'").fetchone()
    return bool(row and row["v"] == "1")


def set_glass_enabled(db_path: Union[str, Path], enabled: bool) -> bool:
    val = "1" if enabled else "0"
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('glass_enabled', ?)",
            (val,),
        )
        c.commit()
    return bool(enabled)


BUDGET_KEYS = ("budget_daily_usd", "budget_weekly_usd", "budget_monthly_usd")


def get_budgets(db_path: Union[str, Path]) -> dict:
    """Return current budget caps in USD, or None per period when unset."""
    out = {k: None for k in BUDGET_KEYS}
    with connect(db_path) as c:
        for row in c.execute(
            f"SELECT k, v FROM plan WHERE k IN ({','.join('?' * len(BUDGET_KEYS))})",
            BUDGET_KEYS,
        ):
            try:
                v = float(row["v"])
                out[row["k"]] = v if v > 0 else None
            except (TypeError, ValueError):
                out[row["k"]] = None
    return out


def set_budget(db_path: Union[str, Path], key: str, amount) -> "float | None":
    """Persist a budget cap. Pass None or 0 to clear it."""
    if key not in BUDGET_KEYS:
        return None
    if amount in (None, "", 0):
        with connect(db_path) as c:
            c.execute("DELETE FROM plan WHERE k=?", (key,))
            c.commit()
        return None
    try:
        v = float(amount)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        with connect(db_path) as c:
            c.execute("DELETE FROM plan WHERE k=?", (key,))
            c.commit()
        return None
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)", (key, str(v)))
        c.commit()
    return v


def get_glass_opacity(db_path: Union[str, Path]) -> int:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='glass_opacity'").fetchone()
    if row:
        try:
            n = int(row["v"])
            return max(0, min(100, n))
        except (TypeError, ValueError):
            pass
    return DEFAULT_GLASS_OPACITY


def set_glass_opacity(db_path: Union[str, Path], opacity: int) -> int:
    try:
        n = int(opacity)
    except (TypeError, ValueError):
        n = DEFAULT_GLASS_OPACITY
    n = max(0, min(100, n))
    with connect(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('glass_opacity', ?)",
            (str(n),),
        )
        c.commit()
    return n


LIMIT_RESET_KEYS = ("limits_five_hour_reset_at", "limits_weekly_reset_at")


def _normalize_iso_utc(s: str) -> "str | None":
    """Parse an ISO 8601 datetime; assume UTC if naive; return canonical `…Z` form or None."""
    if not isinstance(s, str) or not s.strip():
        return None
    raw = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def get_limit_reset_at(db_path: Union[str, Path], key: str) -> "str | None":
    if key not in LIMIT_RESET_KEYS:
        return None
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k=?", (key,)).fetchone()
    if not row or not row["v"]:
        return None
    return row["v"]


def set_limit_reset_at(db_path: Union[str, Path], key: str, value) -> "str | None":
    if key not in LIMIT_RESET_KEYS:
        return None
    if value in (None, ""):
        with connect(db_path) as c:
            c.execute("DELETE FROM plan WHERE k=?", (key,))
            c.commit()
        return None
    canonical = _normalize_iso_utc(value)
    if canonical is None:
        return None
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)", (key, canonical))
        c.commit()
    return canonical


def get_anthropic_api_key(db_path: Union[str, Path]) -> "str | None":
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='anthropic_api_key'").fetchone()
    if not row or not row["v"]:
        return None
    return row["v"]


def set_anthropic_api_key(db_path: Union[str, Path], value) -> "str | None":
    if value in (None, ""):
        with connect(db_path) as c:
            c.execute("DELETE FROM plan WHERE k='anthropic_api_key'")
            c.commit()
        return None
    v = str(value).strip()
    if not v:
        with connect(db_path) as c:
            c.execute("DELETE FROM plan WHERE k='anthropic_api_key'")
            c.commit()
        return None
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('anthropic_api_key', ?)", (v,))
        c.commit()
    return v


def get_limits_sync_meta(db_path: Union[str, Path]) -> dict:
    out = {"last_sync_at": None, "last_sync_status": None}
    with connect(db_path) as c:
        for row in c.execute(
            "SELECT k, v FROM plan WHERE k IN ('limits_last_sync_at', 'limits_last_sync_status')"
        ):
            if row["k"] == "limits_last_sync_at":
                out["last_sync_at"] = row["v"]
            elif row["k"] == "limits_last_sync_status":
                out["last_sync_status"] = row["v"]
    return out


def set_limits_sync_meta(db_path: Union[str, Path], *, status: str, at_iso: str) -> None:
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_last_sync_at', ?)", (at_iso,))
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_last_sync_status', ?)", (status,))
        c.commit()
