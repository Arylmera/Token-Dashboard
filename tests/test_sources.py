"""Tests for the attached-source registry + UNION view behavior."""
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from token_dashboard.db import connect, init_db
from token_dashboard.db.queries import overview_totals, recent_sessions, all_tags
from token_dashboard.db.sources import (
    _safe_name,
    _unique_name,
    add_source,
    list_sources,
    remove_source,
    set_source_enabled,
    sources_dir,
)


def _make_source_db(path: Path, *, messages: list = None, tags: list = None) -> bytes:
    """Build a minimal source DB matching the dashboard schema and return its bytes."""
    init_db(path)
    if messages:
        cols = list(messages[0].keys())
        col_list = ", ".join(cols)
        placeholders = ", ".join("?" * len(cols))
        with sqlite3.connect(path) as c:
            c.executemany(
                f"INSERT INTO messages ({col_list}) VALUES ({placeholders})",
                [tuple(m[c] for c in cols) for m in messages],
            )
            c.commit()
    if tags:
        with sqlite3.connect(path) as c:
            c.executemany(
                "INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) VALUES (?, ?, ?)",
                [(t["session_id"], t["tag"], t.get("created_at", time.time())) for t in tags],
            )
            c.commit()
    return path.read_bytes()


def _msg(uuid: str, sid: str, *, type_="assistant", in_tok=10, out_tok=20, ts="2026-01-01T12:00:00Z"):
    return {
        "uuid": uuid, "parent_uuid": None, "session_id": sid, "project_slug": "p",
        "cwd": "/tmp/p", "git_branch": None, "cc_version": None, "entrypoint": None,
        "type": type_, "is_sidechain": 0, "agent_id": None, "timestamp": ts,
        "model": "claude-sonnet-4-5", "stop_reason": None, "prompt_id": None, "message_id": None,
        "input_tokens": in_tok, "output_tokens": out_tok, "cache_read_tokens": 0,
        "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
        "prompt_text": None, "prompt_chars": None, "tool_calls_json": None,
    }


class NameSanitizationTests(unittest.TestCase):
    def test_safe_name_strips_path_components(self):
        self.assertEqual(_safe_name("../../etc/passwd"), "passwd.db")

    def test_safe_name_replaces_unsafe_chars(self):
        self.assertEqual(_safe_name("my db file!@#.db"), "my_db_file_.db")

    def test_safe_name_appends_db_extension(self):
        self.assertEqual(_safe_name("export"), "export.db")

    def test_safe_name_falls_back_to_default(self):
        self.assertEqual(_safe_name(""), "source.db")
        self.assertEqual(_safe_name("___"), "source.db")


class UniqueNameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "main.db")
        init_db(self.db_path)

    def test_unique_name_no_collision(self):
        self.assertEqual(_unique_name(self.db_path, "foo.db"), "foo.db")

    def test_unique_name_suffixes_on_collision(self):
        # Pre-register so the candidate collides.
        with connect(self.db_path) as c:
            c.execute(
                "INSERT INTO attached_sources (name, path, enabled, added_at) VALUES (?, ?, 1, ?)",
                ("foo.db", "/tmp/foo.db", time.time()),
            )
            c.commit()
        self.assertEqual(_unique_name(self.db_path, "foo.db"), "foo-2.db")


class CrudTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_path = self.tmp / "main.db"
        init_db(self.db_path)
        # Make sure attached files land under the main DB's parent dir.
        self.src_db = self.tmp / "external.db"
        self.src_bytes = _make_source_db(self.src_db)

    def test_add_valid_source(self):
        row = add_source(self.db_path, "external.db", self.src_bytes)
        self.assertEqual(row["name"], "external.db")
        self.assertTrue(row["enabled"])
        self.assertTrue(Path(row["path"]).exists())
        self.assertEqual(row["size_bytes"], len(self.src_bytes))

    def test_add_rejects_non_sqlite(self):
        with self.assertRaises(ValueError):
            add_source(self.db_path, "x.db", b"not a database")

    def test_add_rejects_db_without_messages_table(self):
        bogus = self.tmp / "bogus.db"
        with sqlite3.connect(bogus) as c:
            c.execute("CREATE TABLE notes (k TEXT)")
            c.commit()
        with self.assertRaises(ValueError):
            add_source(self.db_path, "bogus.db", bogus.read_bytes())
        # File should not have been kept under sources dir.
        kept = list(sources_dir(self.db_path).glob("bogus*"))
        self.assertEqual(kept, [])

    def test_list_includes_added_source(self):
        add_source(self.db_path, "external.db", self.src_bytes)
        rows = list_sources(self.db_path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "external.db")
        self.assertTrue(rows[0]["exists"])

    def test_toggle_flips_enabled(self):
        add_source(self.db_path, "external.db", self.src_bytes)
        self.assertTrue(set_source_enabled(self.db_path, "external.db", False))
        rows = list_sources(self.db_path)
        self.assertFalse(rows[0]["enabled"])

    def test_toggle_unknown_returns_false(self):
        self.assertFalse(set_source_enabled(self.db_path, "nope.db", True))

    def test_remove_deletes_file_and_row(self):
        row = add_source(self.db_path, "external.db", self.src_bytes)
        self.assertTrue(Path(row["path"]).exists())
        self.assertTrue(remove_source(self.db_path, "external.db"))
        self.assertFalse(Path(row["path"]).exists())
        self.assertEqual(list_sources(self.db_path), [])

    def test_filename_collision_gets_suffix(self):
        add_source(self.db_path, "external.db", self.src_bytes)
        row2 = add_source(self.db_path, "external.db", self.src_bytes)
        self.assertEqual(row2["name"], "external-2.db")


class UnionViewTests(unittest.TestCase):
    """End-to-end: enabling a source unions its rows into read queries."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_path = self.tmp / "main.db"
        init_db(self.db_path)
        # Seed main DB with one assistant message.
        with sqlite3.connect(self.db_path) as c:
            m = _msg("u-main", "s-main", in_tok=100, out_tok=200)
            cols = ", ".join(m.keys())
            ph = ", ".join("?" * len(m))
            c.execute(f"INSERT INTO messages ({cols}) VALUES ({ph})", tuple(m.values()))
            c.commit()
        # Build source DB with one disjoint message.
        self.src_db = self.tmp / "src.db"
        self.src_bytes = _make_source_db(
            self.src_db,
            messages=[_msg("u-src", "s-src", in_tok=300, out_tok=400)],
            tags=[{"session_id": "s-src", "tag": "imported"}],
        )

    def test_overview_main_only_when_no_sources(self):
        totals = overview_totals(self.db_path)
        self.assertEqual(totals["input_tokens"], 100)
        self.assertEqual(totals["output_tokens"], 200)

    def test_overview_unions_enabled_source(self):
        add_source(self.db_path, "src.db", self.src_bytes)
        totals = overview_totals(self.db_path)
        self.assertEqual(totals["input_tokens"], 400)
        self.assertEqual(totals["output_tokens"], 600)

    def test_disabled_source_excluded(self):
        add_source(self.db_path, "src.db", self.src_bytes)
        set_source_enabled(self.db_path, "src.db", False)
        totals = overview_totals(self.db_path)
        self.assertEqual(totals["input_tokens"], 100)

    def test_overlapping_uuid_double_counts(self):
        """Documented behavior: plain UNION ALL means overlap is summed.

        Row-level dedup was dropped because ROW_NUMBER over a union of
        multi-million-row tables turned every dashboard query into a 30s+
        scan. Realistic use case (attaching another machine's DB) has
        disjoint uuids; re-attaching your own export will double totals.
        """
        dup_db = self.tmp / "dup.db"
        _make_source_db(
            dup_db, messages=[_msg("u-main", "s-main", in_tok=999, out_tok=999)])
        add_source(self.db_path, "dup.db", dup_db.read_bytes())
        totals = overview_totals(self.db_path)
        self.assertEqual(totals["input_tokens"], 100 + 999)
        self.assertEqual(totals["output_tokens"], 200 + 999)

    def test_session_tags_unioned(self):
        add_source(self.db_path, "src.db", self.src_bytes)
        tags = all_tags(self.db_path)
        self.assertIn("imported", [t["tag"] for t in tags])

    def test_missing_file_skipped_gracefully(self):
        # Register a row pointing at a path that doesn't exist (simulates a
        # source whose .db file was deleted out from under us).
        with connect(self.db_path) as c:
            c.execute(
                "INSERT INTO attached_sources (name, path, enabled, added_at) VALUES (?, ?, 1, ?)",
                ("phantom.db", str(self.tmp / "does-not-exist.db"), time.time()),
            )
            c.commit()
        # Read still works, just without the source data.
        totals = overview_totals(self.db_path)
        self.assertEqual(totals["input_tokens"], 100)


if __name__ == "__main__":
    unittest.main()
