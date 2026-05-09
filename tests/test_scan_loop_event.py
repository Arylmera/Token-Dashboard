"""Verifies _scan_loop publishes the change manifest in the scan event."""
import unittest
from unittest.mock import patch

from token_dashboard.server import scan_loop


class ScanLoopEventTests(unittest.TestCase):
    def test_scan_event_includes_changed_manifest(self) -> None:
        manifest_return = {
            "messages": 3, "tools": 0, "files": 1,
            "sessions": ["sess-1"], "projects": ["proj-a"],
            "days": ["2026-05-09"], "models": ["claude-opus-4-7"],
            "min_ts": "2026-05-09T08:00:00.000Z",
            "max_ts": "2026-05-09T09:00:00.000Z",
        }
        published = []
        with patch.object(scan_loop, "scan_dir", return_value=manifest_return), \
             patch.object(scan_loop.EVENTS, "publish", side_effect=lambda evt: published.append(evt)), \
             patch.object(scan_loop.time, "sleep", side_effect=KeyboardInterrupt):
            try:
                scan_loop._scan_loop("db", "projects", interval=0)
            except KeyboardInterrupt:
                pass

        self.assertEqual(len(published), 1)
        evt = published[0]
        self.assertEqual(evt["type"], "scan")
        self.assertEqual(evt["n"], {"messages": 3})
        self.assertEqual(evt["changed"]["sessions"], ["sess-1"])
        self.assertEqual(evt["changed"]["projects"], ["proj-a"])
        self.assertEqual(evt["changed"]["days"], ["2026-05-09"])
        self.assertEqual(evt["changed"]["models"], ["claude-opus-4-7"])
        self.assertEqual(evt["changed"]["min_ts"], "2026-05-09T08:00:00.000Z")
        self.assertEqual(evt["changed"]["max_ts"], "2026-05-09T09:00:00.000Z")
        self.assertIn("ts", evt)

    def test_no_event_when_zero_messages(self) -> None:
        manifest_return = {
            "messages": 0, "tools": 0, "files": 0,
            "sessions": [], "projects": [], "days": [], "models": [],
            "min_ts": None, "max_ts": None,
        }
        published = []
        with patch.object(scan_loop, "scan_dir", return_value=manifest_return), \
             patch.object(scan_loop.EVENTS, "publish", side_effect=lambda evt: published.append(evt)), \
             patch.object(scan_loop.time, "sleep", side_effect=KeyboardInterrupt):
            try:
                scan_loop._scan_loop("db", "projects", interval=0)
            except KeyboardInterrupt:
                pass
        self.assertEqual(published, [])


if __name__ == "__main__":
    unittest.main()
