"""SQLite schema, migrations, and connection helpers."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Union

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  mtime       REAL    NOT NULL,
  bytes_read  INTEGER NOT NULL,
  scanned_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  uuid                    TEXT PRIMARY KEY,
  parent_uuid             TEXT,
  session_id              TEXT NOT NULL,
  project_slug            TEXT NOT NULL,
  cwd                     TEXT,
  git_branch              TEXT,
  cc_version              TEXT,
  entrypoint              TEXT,
  type                    TEXT NOT NULL,
  is_sidechain            INTEGER NOT NULL DEFAULT 0,
  agent_id                TEXT,
  timestamp               TEXT NOT NULL,
  model                   TEXT,
  stop_reason             TEXT,
  prompt_id               TEXT,
  message_id              TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_text             TEXT,
  prompt_chars            INTEGER,
  tool_calls_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  use_id        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);
CREATE INDEX IF NOT EXISTS idx_tools_use_id  ON tool_calls(session_id, use_id);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  REAL NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

CREATE TABLE IF NOT EXISTS attached_sources (
  name        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    REAL    NOT NULL,
  size_bytes  INTEGER
);
"""


def default_db_path() -> Path:
    return Path.home() / ".claude" / "token-dashboard.db"


def init_db(path: Union[str, Path]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as c:
        _migrate_add_message_id(c)
        _migrate_add_tool_use_id(c)
        c.executescript(SCHEMA)


def _migrate_add_message_id(conn) -> None:
    """Add messages.message_id for streaming-snapshot dedup.

    Why: pre-migration rows were summed from all streaming snapshots (over-count).
    How to apply: if the old table exists without the column, add it and clear
    messages/tool_calls/files so the next scan replays JSONLs cleanly. Source
    of truth is on disk; rescanning is cheap.
    """
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
    if "message_id" in cols:
        return
    conn.execute("ALTER TABLE messages ADD COLUMN message_id TEXT")
    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM tool_calls")
    conn.execute("DELETE FROM files")
    conn.commit()


def _migrate_add_tool_use_id(conn) -> None:
    """Add tool_calls.use_id so result_tokens can be joined back to the tool_use.

    Why: pre-migration tool_use rows had no link to their matching _tool_result
    row (the result rows hold result_tokens but live on a separate message),
    making per-tool token attribution impossible.
    How to apply: if the old table exists without the column, add it and clear
    tool_calls + files so the next scan replays JSONLs and populates use_id.
    """
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_calls'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(tool_calls)")}
    if "use_id" in cols:
        return
    conn.execute("ALTER TABLE tool_calls ADD COLUMN use_id TEXT")
    conn.execute("DELETE FROM tool_calls")
    conn.execute("DELETE FROM files")
    conn.commit()


# Numeric columns in source tables. Missing cols are projected as 0 (not NULL)
# so SUM/arithmetic in unCOALESCEd query expressions stay well-defined.
_NUMERIC_COLS = {
    "messages": {
        "is_sidechain",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_create_5m_tokens",
        "cache_create_1h_tokens",
        "prompt_chars",
    },
    "tool_calls": {"result_tokens", "is_error"},
    "session_tags": set(),
}


def _column_expr(col: str, src_cols: set, table: str) -> str:
    """Build a SELECT column expr for a source table.

    Present → just the column name. Missing numeric → `0 AS col`. Missing
    other → `NULL AS col`. Keeps UNION ALL across schema versions safe.
    """
    if col in src_cols:
        return col
    if col in _NUMERIC_COLS.get(table, set()):
        return f"0 AS {col}"
    return f"NULL AS {col}"


def _setup_source_views(conn) -> None:
    """ATTACH enabled sources and create `*_all` UNION views.

    Quietly skips sources whose file is missing, can't be attached, or lacks
    the table. Always creates the views — when no sources are attached,
    `*_all` is a passthrough to main. Read paths (queries.py, tips.py) read
    from the views; writes still target base tables on main.
    """
    try:
        rows = conn.execute(
            "SELECT name, path FROM attached_sources WHERE enabled=1 ORDER BY rowid"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []

    aliases: list[str] = []
    for i, row in enumerate(rows):
        src_path = row["path"] if isinstance(row, sqlite3.Row) else row[1]
        if not src_path or not Path(src_path).exists():
            continue
        alias = f"src{i}"
        try:
            conn.execute(f"ATTACH DATABASE ? AS {alias}", (src_path,))
        except sqlite3.OperationalError:
            continue
        aliases.append(alias)

    for table in ("messages", "tool_calls", "session_tags"):
        cols = [r[1] for r in conn.execute(f"PRAGMA main.table_info({table})")]
        if not cols:
            # main DB doesn't have the table yet (init_db hasn't run) — skip view.
            continue
        col_list = ", ".join(cols)

        usable_aliases = []
        for alias in aliases:
            src_cols = {
                r[1] for r in conn.execute(f"PRAGMA {alias}.table_info({table})")
            }
            if src_cols:
                usable_aliases.append((alias, src_cols))

        if not usable_aliases:
            view_sql = (
                f"CREATE TEMP VIEW {table}_all AS "
                f"SELECT {col_list} FROM main.{table}"
            )
        else:
            # Plain UNION ALL — no row-level dedup. ROW_NUMBER OVER
            # (PARTITION BY uuid) over a multi-million-row union is far too
            # slow for interactive endpoints (sessions/projects/etc would
            # time out at 30s). The realistic use case is attaching DBs from
            # different machines, where uuid collisions are vanishingly
            # rare. If a user re-attaches their own export, totals will
            # double-count — that's documented behavior, not a bug.
            parts = [f"SELECT {col_list} FROM main.{table}"]
            for alias, src_cols in usable_aliases:
                projected = ", ".join(_column_expr(c, src_cols, table) for c in cols)
                parts.append(f"SELECT {projected} FROM {alias}.{table}")
            union_sql = " UNION ALL ".join(parts)
            view_sql = f"CREATE TEMP VIEW {table}_all AS {union_sql}"
        conn.execute(view_sql)


@contextmanager
def connect(path: Union[str, Path]):
    # Bumped timeout: with attached sources + ThreadingHTTPServer, multiple
    # request threads can be running long UNION-ALL aggregations while
    # another thread tries to commit a write (toggle/delete a source).
    # SQLite's default 5s timeout is too short — 30s lets writers wait out
    # in-flight readers instead of failing with "database is locked".
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        _setup_source_views(conn)
        yield conn
    finally:
        conn.close()
