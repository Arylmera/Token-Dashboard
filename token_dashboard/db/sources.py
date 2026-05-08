"""Attached source DB registry.

A "source" is a separately-stored .db file (typically an export from another
machine) that the dashboard unions into its read queries when enabled. Files
live next to the main DB under `<db_dir>/token-dashboard-sources/`. The
registry lives in `attached_sources` (one row per file). Read-side wiring is
in `schema._setup_source_views` — this module just owns CRUD.
"""
from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from typing import Union

from .schema import connect

_SQLITE_MAGIC = b"SQLite format 3\x00"


def sources_dir(db_path: Union[str, Path]) -> Path:
    """Directory holding attached source .db files. Created on demand."""
    db_path = Path(db_path)
    d = db_path.parent / "token-dashboard-sources"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_name(filename: str) -> str:
    """Sanitize an upload filename for on-disk storage.

    Strips path components, drops anything outside [A-Za-z0-9._-], collapses
    repeated separators. Always non-empty (falls back to 'source.db').
    """
    base = Path(filename).name or "source.db"
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    if not cleaned:
        cleaned = "source.db"
    if not cleaned.lower().endswith(".db"):
        cleaned = f"{cleaned}.db"
    return cleaned


def _unique_name(db_path, candidate: str) -> str:
    """Suffix `-2`, `-3` ... if `candidate` collides with an existing source."""
    with connect(db_path) as c:
        existing = {r["name"] for r in c.execute(
            "SELECT name FROM attached_sources")}
    if candidate not in existing:
        return candidate
    stem = candidate[:-3] if candidate.lower().endswith(".db") else candidate
    n = 2
    while True:
        trial = f"{stem}-{n}.db"
        if trial not in existing:
            return trial
        n += 1


def list_sources(db_path: Union[str, Path]) -> list:
    """All registered sources ordered by add time (oldest first)."""
    with connect(db_path) as c:
        rows = c.execute(
            "SELECT name, path, enabled, added_at, size_bytes "
            "FROM attached_sources ORDER BY added_at ASC"
        ).fetchall()
    out = []
    for r in rows:
        path = Path(r["path"])
        out.append({
            "name": r["name"],
            "path": r["path"],
            "enabled": bool(r["enabled"]),
            "added_at": r["added_at"],
            "size_bytes": r["size_bytes"],
            "exists": path.exists(),
        })
    return out


def add_source(db_path: Union[str, Path], filename: str, file_bytes: bytes) -> dict:
    """Validate + store an uploaded source DB and register it (enabled).

    Returns the registry row dict. Raises ValueError on invalid input.
    """
    if not file_bytes or not file_bytes.startswith(_SQLITE_MAGIC):
        raise ValueError("not a SQLite database")

    name = _unique_name(db_path, _safe_name(filename))
    target = sources_dir(db_path) / name
    target.write_bytes(file_bytes)

    # Sanity-check that the file at least has a `messages` table — so users
    # learn at upload time rather than seeing empty totals after toggling on.
    # Note: sqlite3.Connection's `with` block doesn't close, so we close
    # explicitly to release the Windows file handle before any unlink.
    has_msgs = None
    probe_err: "Exception | None" = None
    probe = None
    try:
        probe = sqlite3.connect(target)
        has_msgs = probe.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
        ).fetchone()
    except sqlite3.DatabaseError as e:
        probe_err = e
    finally:
        if probe is not None:
            probe.close()
    if probe_err is not None:
        target.unlink(missing_ok=True)
        raise ValueError("file is not a readable SQLite database")
    if not has_msgs:
        target.unlink(missing_ok=True)
        raise ValueError("source DB has no `messages` table")

    now = time.time()
    with connect(db_path) as c:
        c.execute(
            "INSERT INTO attached_sources (name, path, enabled, added_at, size_bytes) "
            "VALUES (?, ?, 1, ?, ?)",
            (name, str(target), now, len(file_bytes)),
        )
        c.commit()
    return {
        "name": name,
        "path": str(target),
        "enabled": True,
        "added_at": now,
        "size_bytes": len(file_bytes),
        "exists": True,
    }


def remove_source(db_path: Union[str, Path], name: str) -> bool:
    """Delete file from disk + registry row. Returns True if a row was removed.

    The unlink happens AFTER the connect context exits — `connect()` ATTACHes
    every enabled source, and Windows refuses to delete an ATTACHed file even
    after the row is deleted in the same transaction.
    """
    with connect(db_path) as c:
        row = c.execute(
            "SELECT path FROM attached_sources WHERE name=?", (name,)
        ).fetchone()
        if not row:
            return False
        path_to_remove = row["path"]
        c.execute("DELETE FROM attached_sources WHERE name=?", (name,))
        c.commit()
    Path(path_to_remove).unlink(missing_ok=True)
    return True


def set_source_enabled(db_path: Union[str, Path], name: str, enabled: bool) -> bool:
    """Toggle enabled flag. Returns True if the row exists."""
    with connect(db_path) as c:
        cur = c.execute(
            "UPDATE attached_sources SET enabled=? WHERE name=?",
            (1 if enabled else 0, name),
        )
        c.commit()
        return cur.rowcount > 0
