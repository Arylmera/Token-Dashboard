import http.server
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.request

from token_dashboard.db import init_db
from token_dashboard.server import build_handler


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) VALUES ('u',NULL,'s','p','user','2026-04-19T00:00:00Z',NULL,0,0,0,0,0,'hi',2)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a','u','s','p','assistant','2026-04-19T00:00:01Z','claude-haiku-4-5',1,1,0,0,0)")
            c.commit()
        self.port = _free_port()
        H = build_handler(self.db, projects_dir="/nonexistent")
        self.httpd = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()

    def _get(self, path):
        return urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}").read()

    def test_index_html(self):
        body = self._get("/")
        self.assertIn(b"Token Dashboard", body)

    def test_overview_json(self):
        body = json.loads(self._get("/api/overview"))
        self.assertIn("sessions", body)
        self.assertEqual(body["sessions"], 1)

    def test_prompts_json(self):
        body = json.loads(self._get("/api/prompts?limit=10"))
        self.assertIsInstance(body, list)

    def test_projects_json(self):
        body = json.loads(self._get("/api/projects"))
        self.assertIsInstance(body, list)
        self.assertEqual(body[0]["project_slug"], "p")

    def test_plan_json(self):
        body = json.loads(self._get("/api/plan"))
        self.assertIn("plan", body)
        self.assertIn("pricing", body)

    def test_limits_json(self):
        body = json.loads(self._get("/api/limits"))
        self.assertIn("plan", body)
        self.assertIn("five_hour", body)
        self.assertIn("weekly", body)
        self.assertIn("used", body["five_hour"])
        self.assertIn("pct_remaining", body["weekly"])

    def test_preferences_default(self):
        body = json.loads(self._get("/api/preferences"))
        self.assertEqual(body["badge_metric"], "tokens")
        self.assertIn("tokens", body["badge_metrics"])
        self.assertIn("burn", body["badge_metrics"])

    def test_preferences_set_and_round_trip(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/preferences",
            data=json.dumps({"badge_metric": "burn"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = json.loads(urllib.request.urlopen(req).read())
        self.assertEqual(resp["badge_metric"], "burn")
        body = json.loads(self._get("/api/preferences"))
        self.assertEqual(body["badge_metric"], "burn")

    def test_preferences_rejects_unknown_metric(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/preferences",
            data=json.dumps({"badge_metric": "bogus"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = json.loads(urllib.request.urlopen(req).read())
        self.assertEqual(resp["badge_metric"], "tokens")

    def test_head_returns_200_not_501(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")

    def test_head_api_endpoint(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/overview", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")

    def _post(self, path, body):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return json.loads(urllib.request.urlopen(req).read())

    def test_tag_add_remove_round_trip(self):
        resp = self._post("/api/sessions/s/tags", {"add": ["client-a", "  client-a  ", "billable"]})
        self.assertEqual(set(resp["tags"]), {"client-a", "billable"})
        # Per-session GET reflects them
        body = json.loads(self._get("/api/sessions/s/tags"))
        self.assertEqual(set(body["tags"]), {"client-a", "billable"})
        # Aggregate /api/tags shows counts
        all_tags = json.loads(self._get("/api/tags"))
        names = [t["tag"] for t in all_tags]
        self.assertIn("client-a", names)
        # Remove one
        resp = self._post("/api/sessions/s/tags", {"remove": ["client-a"]})
        self.assertEqual(resp["tags"], ["billable"])

    def test_sessions_filtered_by_tag(self):
        self._post("/api/sessions/s/tags", {"add": ["alpha"]})
        body = json.loads(self._get("/api/sessions?tag=alpha"))
        self.assertEqual(len(body), 1)
        body = json.loads(self._get("/api/sessions?tag=does-not-exist"))
        self.assertEqual(body, [])

    def test_csv_export(self):
        self._post("/api/sessions/s/tags", {"add": ["alpha"]})
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/export.csv") as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("text/csv", resp.headers.get("Content-Type", ""))
            csv_body = resp.read().decode("utf-8")
        self.assertIn("session_id", csv_body)  # header row
        self.assertIn("alpha", csv_body)        # tag column populated

    def test_budget_get_and_set(self):
        # Defaults: caps unset, status ok
        body = json.loads(self._get("/api/budget"))
        self.assertIsNone(body["daily"]["cap_usd"])
        # Set caps
        resp = self._post("/api/budget", {"daily": 5, "weekly": 25, "monthly": 100})
        self.assertEqual(resp["daily"], 5.0)
        body = json.loads(self._get("/api/budget"))
        self.assertEqual(body["daily"]["cap_usd"], 5.0)
        self.assertEqual(body["weekly"]["cap_usd"], 25.0)
        self.assertIn(body["daily"]["status"], ("ok", "warn", "over"))
        # Clear with null
        self._post("/api/budget", {"daily": None})
        body = json.loads(self._get("/api/budget"))
        self.assertIsNone(body["daily"]["cap_usd"])

    def _post_binary(self, path, blob, content_type="application/x-sqlite3"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=blob,
            headers={"Content-Type": content_type},
            method="POST",
        )
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())

    def test_import_round_trip_and_idempotent(self):
        # 1. Export the seeded DB.
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/export.db") as resp:
            blob = resp.read()
        # 2. Stand up a SECOND server pointed at a fresh DB.
        other_db = os.path.join(self.tmp, "other.db")
        init_db(other_db)
        port2 = _free_port()
        H = build_handler(other_db, projects_dir="/nonexistent")
        httpd2 = http.server.HTTPServer(("127.0.0.1", port2), H)
        threading.Thread(target=httpd2.serve_forever, daemon=True).start()
        try:
            # Pre-import: empty.
            req = urllib.request.Request(f"http://127.0.0.1:{port2}/api/overview")
            self.assertEqual(json.loads(urllib.request.urlopen(req).read())["sessions"], 0)
            # Import.
            req = urllib.request.Request(
                f"http://127.0.0.1:{port2}/api/import.db",
                data=blob,
                headers={"Content-Type": "application/x-sqlite3"},
                method="POST",
            )
            resp = json.loads(urllib.request.urlopen(req).read())
            self.assertTrue(resp["ok"])
            self.assertEqual(resp["messages_added"], 2)
            # Post-import: visible.
            body = json.loads(urllib.request.urlopen(
                f"http://127.0.0.1:{port2}/api/overview").read())
            self.assertEqual(body["sessions"], 1)
            # Idempotency: re-import adds zero messages.
            req = urllib.request.Request(
                f"http://127.0.0.1:{port2}/api/import.db",
                data=blob,
                headers={"Content-Type": "application/x-sqlite3"},
                method="POST",
            )
            resp = json.loads(urllib.request.urlopen(req).read())
            self.assertEqual(resp["messages_added"], 0)
        finally:
            httpd2.shutdown()

    def test_import_rejects_non_sqlite(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/import.db",
            data=b"not a database, just some bytes",
            headers={"Content-Type": "application/x-sqlite3"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req)
            self.fail("expected 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            err = json.loads(e.read())
            self.assertIn("SQLite", err["error"])

    def test_import_rejects_empty_body(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/import.db",
            data=b"",
            headers={"Content-Type": "application/x-sqlite3"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req)
            self.fail("expected 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_export_db_is_valid_sqlite(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/export.db") as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("sqlite", resp.headers.get("Content-Type", ""))
            blob = resp.read()
        # SQLite files start with this magic header.
        self.assertTrue(blob.startswith(b"SQLite format 3\x00"))
        # Round-trip: open it and confirm it carries the seeded fixture row.
        out = os.path.join(self.tmp, "exported.db")
        with open(out, "wb") as f:
            f.write(blob)
        with sqlite3.connect(out) as c:
            rows = list(c.execute("SELECT session_id FROM messages WHERE type='user'"))
            self.assertEqual(rows, [("s",)])

    def test_phase_split(self):
        body = json.loads(self._get("/api/phase-split"))
        for k in ("plan", "execute", "other"):
            self.assertIn(k, body)
            self.assertIn("billable_tokens", body[k])
            self.assertIn("turns", body[k])


if __name__ == "__main__":
    unittest.main()
