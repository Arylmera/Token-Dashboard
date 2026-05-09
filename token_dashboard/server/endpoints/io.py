"""Bulk import/export: CSV of sessions, full SQLite snapshot download/upload."""
from __future__ import annotations

from pathlib import Path

from ...db import recent_sessions
from ..http_utils import MAX_IMPORT_BYTES, send_error_json, send_json


def export_csv(handler, db_path, pricing, qs):
    """Sessions CSV with optional since/until/tag filters. RFC 4180 quoting."""
    import csv
    import io
    rows = recent_sessions(
        db_path,
        limit=10_000,
        since=qs.get("since", [None])[0],
        until=qs.get("until", [None])[0],
        pricing=pricing,
        tag=qs.get("tag", [None])[0] or None,
    )
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writerow([
        "session_id", "project_slug", "project_name",
        "started", "ended", "turns", "tokens", "cost_usd",
        "model", "tags", "first_prompt",
    ])
    for r in rows:
        w.writerow([
            r.get("session_id") or "",
            r.get("project_slug") or "",
            r.get("project_name") or "",
            r.get("started") or "",
            r.get("ended") or "",
            r.get("turns") or 0,
            r.get("tokens") or 0,
            f"{r.get('cost_usd') or 0:.6f}",
            r.get("model") or "",
            ",".join(r.get("tags") or []),
            (r.get("first_prompt") or "").replace("\n", " ").strip()[:500],
        ])
    body = buf.getvalue().encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/csv; charset=utf-8")
    handler.send_header("Content-Disposition",
                        'attachment; filename="token-dashboard-sessions.csv"')
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def export_db(handler, db_path, pricing, qs):
    """Stream a consistent snapshot of the SQLite DB.

    Uses sqlite3's online backup API, so a concurrent scan_loop write doesn't
    corrupt the download. We backup to a temp file (lets sqlite handle locking
    cleanly), read it into memory, send with Content-Length, then unlink.
    Memory cost is the DB size; for a desktop tool scanning local JSONLs that's
    tens of MB at most.
    """
    import os as _os
    import sqlite3 as _sqlite3
    import tempfile as _tempfile
    from datetime import datetime as _dt

    fd, tmp_path = _tempfile.mkstemp(suffix=".db", prefix="td-export-")
    _os.close(fd)
    try:
        with _sqlite3.connect(db_path) as src, _sqlite3.connect(tmp_path) as dst:
            src.backup(dst)
        body = Path(tmp_path).read_bytes()
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass

    stamp = _dt.utcnow().strftime("%Y%m%d-%H%M%S")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-sqlite3")
    handler.send_header(
        "Content-Disposition",
        f'attachment; filename="token-dashboard-{stamp}.db"',
    )
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def import_db(handler, db_path) -> None:
    """Merge an uploaded SQLite snapshot into the local DB.

    Wire format: raw bytes in the POST body (no multipart). Caller sends
    Content-Type: application/x-sqlite3 and the file as the body. Dedup is
    natural — messages PK on uuid, session_tags PK on (session_id, tag) — so
    INSERT OR IGNORE handles it. tool_calls has an autoincrement id so we
    delete-then-insert per message_uuid touched by the import; that keeps
    repeat imports idempotent without depending on a synthetic key.

    The whole merge runs in a single transaction so a malformed source DB
    leaves the local DB unchanged.
    """
    import os as _os
    import sqlite3 as _sqlite3
    import tempfile as _tempfile

    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        return send_error_json(handler, 400, "invalid Content-Length")
    if length <= 0:
        return send_error_json(handler, 400, "empty body")
    if length > MAX_IMPORT_BYTES:
        return send_error_json(
            handler, 413, f"upload too large (max {MAX_IMPORT_BYTES} bytes)")

    fd, tmp_path = _tempfile.mkstemp(suffix=".db", prefix="td-import-")
    try:
        with _os.fdopen(fd, "wb") as fh:
            remaining = length
            while remaining > 0:
                chunk = handler.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining != 0:
            return send_error_json(handler, 400, "truncated upload")

        # Magic-header check before we ATTACH — sqlite errors on attach are
        # less helpful than failing fast here.
        with open(tmp_path, "rb") as fh:
            head = fh.read(16)
        if not head.startswith(b"SQLite format 3\x00"):
            return send_error_json(handler, 400, "not a SQLite database")

        with _sqlite3.connect(db_path) as conn:
            # ATTACH path is interpolated, not bound — sqlite forbids `?` here.
            # Quote-escape just in case the temp dir contains a single quote
            # (extremely unlikely on stock macOS/Linux, but cheap to harden).
            attach_path = tmp_path.replace("'", "''")
            conn.execute(f"ATTACH DATABASE '{attach_path}' AS src")
            try:
                src_tables = {
                    row[0] for row in conn.execute(
                        "SELECT name FROM src.sqlite_master WHERE type='table'")
                }
                missing = {"messages", "tool_calls"} - src_tables
                if missing:
                    return send_error_json(
                        handler, 400,
                        f"source DB missing required tables: {sorted(missing)}")

                conn.execute("BEGIN")

                # Count what's actually new before we INSERT, so the response
                # reports adds (not the no-op rows that hit OR IGNORE).
                msg_added = conn.execute(
                    "SELECT COUNT(*) FROM src.messages s "
                    "WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.uuid = s.uuid)"
                ).fetchone()[0]

                # messages — uuid PK is the natural dedup key.
                src_cols = [row[1] for row in conn.execute("PRAGMA src.table_info(messages)")]
                local_cols = [row[1] for row in conn.execute("PRAGMA table_info(messages)")]
                shared = [c for c in local_cols if c in src_cols]
                col_list = ", ".join(shared)
                conn.execute(
                    f"INSERT OR IGNORE INTO messages ({col_list}) "
                    f"SELECT {col_list} FROM src.messages"
                )

                # tool_calls — no natural unique key. Wipe local rows for any
                # message_uuid present in src (a no-op set if those messages
                # didn't already exist locally), then re-insert from src.
                conn.execute("""
                    DELETE FROM tool_calls
                     WHERE message_uuid IN (SELECT uuid FROM src.messages)
                """)
                src_tc_cols = [row[1] for row in conn.execute("PRAGMA src.table_info(tool_calls)")]
                local_tc_cols = [row[1] for row in conn.execute("PRAGMA table_info(tool_calls)")]
                shared_tc = [c for c in local_tc_cols if c in src_tc_cols and c != "id"]
                tc_col_list = ", ".join(shared_tc)
                conn.execute(
                    f"INSERT INTO tool_calls ({tc_col_list}) "
                    f"SELECT {tc_col_list} FROM src.tool_calls"
                )
                tc_added = conn.execute(
                    "SELECT COUNT(*) FROM src.tool_calls"
                ).fetchone()[0]

                # session_tags — composite PK, but only present in newer DBs.
                tags_added = 0
                if "session_tags" in src_tables:
                    tags_added = conn.execute(
                        "SELECT COUNT(*) FROM src.session_tags s "
                        "WHERE NOT EXISTS (SELECT 1 FROM session_tags t "
                        "WHERE t.session_id = s.session_id AND t.tag = s.tag)"
                    ).fetchone()[0]
                    conn.execute("""
                        INSERT OR IGNORE INTO session_tags (session_id, tag, created_at)
                        SELECT session_id, tag, created_at FROM src.session_tags
                    """)

                conn.commit()
            finally:
                conn.execute("DETACH DATABASE src")

        send_json(handler, {
            "ok": True,
            "messages_added": msg_added,
            "tool_calls_imported": tc_added,
            "tags_added": tags_added,
        })
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass
