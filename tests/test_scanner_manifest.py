"""Verifies scan_dir returns the change manifest used by SSE hints."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from token_dashboard.db import init_db
from token_dashboard.scanner import scan_dir


def _line(rec: dict) -> str:
    return json.dumps(rec) + "\n"


class ScanManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.mkdtemp()
        self.root = Path(self.tmp_dir)
        self.projects = self.root / "projects"
        (self.projects / "proj-a").mkdir(parents=True)
        (self.projects / "proj-b").mkdir(parents=True)
        self.db = str(self.root / "test.db")
        init_db(self.db)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _write(self, project: str, session: str, records: list[dict]) -> None:
        path = self.projects / project / f"{session}.jsonl"
        with open(path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(_line(r))

    def test_manifest_collects_distinct_dimensions(self) -> None:
        self._write("proj-a", "sess-1", [
            {"uuid": "u1", "type": "user", "sessionId": "sess-1",
             "timestamp": "2026-05-08T10:00:00.000Z",
             "message": {"content": "hi", "model": "claude-opus-4-7",
                         "usage": {"input_tokens": 5, "output_tokens": 0}}},
            {"uuid": "u2", "type": "assistant", "sessionId": "sess-1",
             "timestamp": "2026-05-09T11:00:00.000Z",
             "message": {"id": "m2", "model": "claude-opus-4-7",
                         "usage": {"output_tokens": 7}}},
        ])
        self._write("proj-b", "sess-2", [
            {"uuid": "u3", "type": "user", "sessionId": "sess-2",
             "timestamp": "2026-05-09T12:00:00.000Z",
             "message": {"content": "yo", "model": "claude-sonnet-4-6",
                         "usage": {"input_tokens": 3, "output_tokens": 0}}},
        ])

        out = scan_dir(self.projects, self.db)

        self.assertEqual(out["messages"], 3)
        self.assertEqual(sorted(out["sessions"]), ["sess-1", "sess-2"])
        self.assertEqual(sorted(out["projects"]), ["proj-a", "proj-b"])
        self.assertEqual(sorted(out["days"]), ["2026-05-08", "2026-05-09"])
        self.assertEqual(sorted(out["models"]), ["claude-opus-4-7", "claude-sonnet-4-6"])
        self.assertEqual(out["min_ts"], "2026-05-08T10:00:00.000Z")
        self.assertEqual(out["max_ts"], "2026-05-09T12:00:00.000Z")

    def test_manifest_empty_on_no_data(self) -> None:
        out = scan_dir(self.projects, self.db)
        self.assertEqual(out["messages"], 0)
        self.assertEqual(out["sessions"], [])
        self.assertEqual(out["projects"], [])
        self.assertEqual(out["days"], [])
        self.assertEqual(out["models"], [])
        self.assertIsNone(out["min_ts"])
        self.assertIsNone(out["max_ts"])

    def test_manifest_skips_records_with_missing_model(self) -> None:
        # User records without a model field should still contribute to
        # sessions/projects/days but must not pollute the model set.
        self._write("proj-a", "sess-1", [
            {"uuid": "u1", "type": "user", "sessionId": "sess-1",
             "timestamp": "2026-05-09T08:00:00.000Z",
             "message": {"content": "hi",
                         "usage": {"input_tokens": 1, "output_tokens": 0}}},
            {"uuid": "u2", "type": "assistant", "sessionId": "sess-1",
             "timestamp": "2026-05-09T08:00:01.000Z",
             "message": {"id": "m2", "model": "claude-opus-4-7",
                         "usage": {"output_tokens": 2}}},
        ])
        out = scan_dir(self.projects, self.db)
        self.assertEqual(out["messages"], 2)
        self.assertEqual(out["models"], ["claude-opus-4-7"])
        self.assertEqual(out["sessions"], ["sess-1"])
        self.assertEqual(out["days"], ["2026-05-09"])

    def test_manifest_empty_on_second_scan_with_no_new_data(self) -> None:
        self._write("proj-a", "sess-1", [
            {"uuid": "u1", "type": "user", "sessionId": "sess-1",
             "timestamp": "2026-05-09T09:00:00.000Z",
             "message": {"content": "first",
                         "model": "claude-opus-4-7",
                         "usage": {"input_tokens": 1, "output_tokens": 0}}},
        ])

        first = scan_dir(self.projects, self.db)
        self.assertEqual(first["messages"], 1)

        # No new bytes appended; second scan should be a no-op manifest.
        second = scan_dir(self.projects, self.db)
        self.assertEqual(second["messages"], 0)
        self.assertEqual(second["sessions"], [])
        self.assertEqual(second["projects"], [])
        self.assertEqual(second["days"], [])
        self.assertEqual(second["models"], [])
        self.assertIsNone(second["min_ts"])
        self.assertIsNone(second["max_ts"])


if __name__ == "__main__":
    unittest.main()
