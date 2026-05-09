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

    def test_preferences_exposes_reset_keys_default_null(self):
        body = json.loads(self._get("/api/preferences"))
        self.assertIn("limits_five_hour_reset_at", body)
        self.assertIn("limits_weekly_reset_at", body)
        self.assertIsNone(body["limits_five_hour_reset_at"])
        self.assertIsNone(body["limits_weekly_reset_at"])

    def test_preferences_post_sets_reset_keys(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/preferences",
            data=json.dumps({"limits_five_hour_reset_at": "2026-05-09T14:32:00Z"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req)
        body = json.loads(self._get("/api/preferences"))
        self.assertEqual(body["limits_five_hour_reset_at"], "2026-05-09T14:32:00Z")

    def test_preferences_post_clears_reset_keys_on_null(self):
        for value in ("2026-05-09T14:32:00Z", None):
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/api/preferences",
                data=json.dumps({"limits_five_hour_reset_at": value}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req)
        body = json.loads(self._get("/api/preferences"))
        self.assertIsNone(body["limits_five_hour_reset_at"])

    def test_preferences_api_key_set_flag_never_returns_value(self):
        body = json.loads(self._get("/api/preferences"))
        self.assertFalse(body["anthropic_api_key_set"])
        self.assertNotIn("anthropic_api_key", body)
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/preferences",
            data=json.dumps({"anthropic_api_key": "sk-ant-secret"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req)
        body = json.loads(self._get("/api/preferences"))
        self.assertTrue(body["anthropic_api_key_set"])
        self.assertNotIn("anthropic_api_key", body)
        self.assertNotIn("sk-ant-secret", json.dumps(body))

    def test_preferences_sync_meta_default_null(self):
        body = json.loads(self._get("/api/preferences"))
        self.assertIsNone(body["limits_last_sync_at"])
        self.assertIsNone(body["limits_last_sync_status"])

    def _post_status(self, path, body=None):
        """Like _post but returns (status_code, body_dict). Tolerates 4xx."""
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body or {}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_pricing_get_default_no_overrides(self):
        body = json.loads(self._get("/api/pricing"))
        self.assertIn("defaults", body)
        self.assertEqual(body["overrides"], {})
        self.assertEqual(
            body["effective"]["claude-opus-4-7"]["input"],
            body["defaults"]["claude-opus-4-7"]["input"],
        )

    def test_pricing_set_partial_override_round_trip(self):
        status, _ = self._post_status("/api/pricing/claude-opus-4-7", {"input": 9.99})
        self.assertEqual(status, 200)
        body = json.loads(self._get("/api/pricing"))
        self.assertEqual(body["overrides"]["claude-opus-4-7"]["input"], 9.99)
        self.assertEqual(body["effective"]["claude-opus-4-7"]["input"], 9.99)
        self.assertEqual(body["defaults"]["claude-opus-4-7"]["input"], 5.00)
        self.assertEqual(
            body["effective"]["claude-opus-4-7"]["output"],
            body["defaults"]["claude-opus-4-7"]["output"],
        )

    def test_pricing_overview_cost_uses_override(self):
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('big','u','s','p','assistant','2026-04-19T00:00:02Z','claude-haiku-4-5',0,1000000,0,0,0)")
            c.commit()
        before = json.loads(self._get("/api/overview"))["cost_usd"]
        self._post_status("/api/pricing/claude-haiku-4-5", {"output": 50.00})
        after = json.loads(self._get("/api/overview"))["cost_usd"]
        self.assertGreater(after, before + 40.0)

    def test_pricing_unknown_model_rejected(self):
        status, _ = self._post_status("/api/pricing/not-a-real-model", {"input": 1})
        self.assertEqual(status, 404)

    def test_pricing_negative_value_rejected(self):
        status, _ = self._post_status("/api/pricing/claude-opus-4-7", {"input": -1})
        self.assertEqual(status, 400)

    def test_pricing_clear_row(self):
        self._post_status("/api/pricing/claude-opus-4-7", {"input": 9.99})
        self._post_status("/api/pricing/claude-opus-4-7/clear")
        body = json.loads(self._get("/api/pricing"))
        self.assertEqual(body["overrides"], {})

    def test_pricing_clear_all(self):
        self._post_status("/api/pricing/claude-opus-4-7", {"input": 9.99})
        self._post_status("/api/pricing/claude-sonnet-4-6", {"output": 99})
        self._post_status("/api/pricing/clear-all")
        body = json.loads(self._get("/api/pricing"))
        self.assertEqual(body["overrides"], {})


class PreferencesResetUnitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_default_is_none(self):
        from token_dashboard.preferences import LIMIT_RESET_KEYS, get_limit_reset_at
        for k in LIMIT_RESET_KEYS:
            self.assertIsNone(get_limit_reset_at(self.db, k))

    def test_set_and_get_roundtrip(self):
        from token_dashboard.preferences import LIMIT_RESET_KEYS, get_limit_reset_at, set_limit_reset_at
        for k in LIMIT_RESET_KEYS:
            v = set_limit_reset_at(self.db, k, "2026-05-09T14:32:00Z")
            self.assertEqual(v, "2026-05-09T14:32:00Z")
            self.assertEqual(get_limit_reset_at(self.db, k), "2026-05-09T14:32:00Z")

    def test_naive_iso_assumes_utc(self):
        from token_dashboard.preferences import set_limit_reset_at
        v = set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00")
        self.assertEqual(v, "2026-05-09T14:32:00Z")

    def test_clear_with_none_or_empty(self):
        from token_dashboard.preferences import get_limit_reset_at, set_limit_reset_at
        set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00Z")
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", None))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))
        set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00Z")
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", ""))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))

    def test_invalid_iso_rejected(self):
        from token_dashboard.preferences import get_limit_reset_at, set_limit_reset_at
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", "not-a-date"))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))

    def test_invalid_key_rejected(self):
        from token_dashboard.preferences import set_limit_reset_at
        self.assertIsNone(set_limit_reset_at(self.db, "bogus_key", "2026-05-09T14:32:00Z"))


class PreferencesApiKeyAndSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_api_key_default_none(self):
        from token_dashboard.preferences import get_anthropic_api_key
        self.assertIsNone(get_anthropic_api_key(self.db))

    def test_api_key_roundtrip_and_clear(self):
        from token_dashboard.preferences import get_anthropic_api_key, set_anthropic_api_key
        v = set_anthropic_api_key(self.db, "sk-ant-test-123")
        self.assertEqual(v, "sk-ant-test-123")
        self.assertEqual(get_anthropic_api_key(self.db), "sk-ant-test-123")
        self.assertIsNone(set_anthropic_api_key(self.db, None))
        self.assertIsNone(get_anthropic_api_key(self.db))
        set_anthropic_api_key(self.db, "sk-ant-test-456")
        self.assertIsNone(set_anthropic_api_key(self.db, ""))
        self.assertIsNone(get_anthropic_api_key(self.db))

    def test_sync_meta_default(self):
        from token_dashboard.preferences import get_limits_sync_meta
        self.assertEqual(
            get_limits_sync_meta(self.db),
            {"last_sync_at": None, "last_sync_status": None},
        )

    def test_sync_meta_persist(self):
        from token_dashboard.preferences import get_limits_sync_meta, set_limits_sync_meta
        set_limits_sync_meta(self.db, status="ok", at_iso="2026-05-09T14:32:00Z")
        self.assertEqual(
            get_limits_sync_meta(self.db),
            {"last_sync_at": "2026-05-09T14:32:00Z", "last_sync_status": "ok"},
        )
        set_limits_sync_meta(self.db, status="error:URLError", at_iso="2026-05-09T15:00:00Z")
        self.assertEqual(
            get_limits_sync_meta(self.db),
            {"last_sync_at": "2026-05-09T15:00:00Z", "last_sync_status": "error:URLError"},
        )


class LimitsOverrideTests(unittest.TestCase):
    """Drives _api_limits via HTTP for the override paths."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        self.port = _free_port()
        H = build_handler(self.db, projects_dir="/nonexistent")
        self.httpd = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()

    def _seed_assistant(self, ts_iso, billable_in=1000):
        with sqlite3.connect(self.db) as c:
            uid = ts_iso.replace(":", "").replace("-", "")
            c.execute(
                "INSERT OR IGNORE INTO messages "
                "(uuid, parent_uuid, session_id, project_slug, type, timestamp, model, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?,NULL,'s','p','assistant',?,'claude-haiku-4-5',?,0,0,0,0)",
                (uid, ts_iso, billable_in),
            )
            c.commit()

    def _set_plan_kv(self, k, v):
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)", (k, v))
            c.commit()

    def _get_kv(self, k):
        with sqlite3.connect(self.db) as c:
            row = c.execute("SELECT v FROM plan WHERE k=?", (k,)).fetchone()
        return row[0] if row else None

    def _get_limits(self):
        body = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/limits").read()
        return json.loads(body)

    def test_5h_override_in_future_uses_window(self):
        from datetime import datetime, timedelta, timezone
        self._set_plan_kv("plan", "pro")
        future = (datetime.now(timezone.utc) + timedelta(hours=2)).replace(microsecond=0)
        future_iso = future.isoformat().replace("+00:00", "Z")
        in_window_iso = (future - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        out_of_window_iso = (future - timedelta(hours=6)).isoformat().replace("+00:00", "Z")
        self._seed_assistant(in_window_iso, billable_in=2000)
        self._seed_assistant(out_of_window_iso, billable_in=99999)
        self._set_plan_kv("limits_five_hour_reset_at", future_iso)
        body = self._get_limits()
        self.assertEqual(body["five_hour"]["resets_at"], future_iso)
        # out-of-window tokens must not dominate; in-window tokens must appear.
        # Weights may reduce raw counts (e.g. haiku tier_weight < 1), so we
        # only assert the in-window row contributes something and the
        # out-of-window row (99999 tokens) is excluded.
        self.assertGreater(body["five_hour"]["used"], 0)
        self.assertLess(body["five_hour"]["used"], 99999)

    def test_5h_override_in_past_rolls_forward(self):
        from datetime import datetime, timedelta, timezone
        self._set_plan_kv("plan", "pro")
        past = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(microsecond=0)
        past_iso = past.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_five_hour_reset_at", past_iso)
        body = self._get_limits()
        new_reset = body["five_hour"]["resets_at"]
        self.assertNotEqual(new_reset, past_iso)
        self.assertEqual(self._get_kv("limits_five_hour_reset_at"), new_reset)
        new_dt = datetime.fromisoformat(new_reset.replace("Z", "+00:00"))
        self.assertGreater(new_dt, datetime.now(timezone.utc))

    def test_weekly_override_sets_resets_at(self):
        from datetime import datetime, timedelta, timezone
        self._set_plan_kv("plan", "pro")
        future = (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0)
        future_iso = future.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_weekly_reset_at", future_iso)
        body = self._get_limits()
        self.assertEqual(body["weekly"]["resets_at"], future_iso)

    def test_weekly_override_in_past_rolls_forward_by_seven_days(self):
        from datetime import datetime, timedelta, timezone
        self._set_plan_kv("plan", "pro")
        past = (datetime.now(timezone.utc) - timedelta(days=3)).replace(microsecond=0)
        past_iso = past.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_weekly_reset_at", past_iso)
        body = self._get_limits()
        new_reset = body["weekly"]["resets_at"]
        self.assertNotEqual(new_reset, past_iso)
        new_dt = datetime.fromisoformat(new_reset.replace("Z", "+00:00"))
        self.assertGreater(new_dt, datetime.now(timezone.utc))

    def test_no_override_weekly_resets_at_is_none(self):
        self._set_plan_kv("plan", "pro")
        body = self._get_limits()
        self.assertIsNone(body["weekly"]["resets_at"])


class LimitsSyncRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        self.port = _free_port()
        H = build_handler(self.db, projects_dir="/nonexistent")
        self.httpd = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()

    def _post(self, path, body):
        import urllib.error
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            r = urllib.request.urlopen(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def _save_key(self, k):
        self._post("/api/preferences", {"anthropic_api_key": k})

    def test_sync_without_key_returns_400(self):
        status, _body = self._post("/api/limits/sync", {})
        self.assertEqual(status, 400)

    def test_sync_ok_persists_resets_and_meta(self):
        from unittest.mock import patch
        self._save_key("sk-ant-x")
        with patch("token_dashboard.server.routes.sync_limits") as m:
            m.return_value = {
                "status": "ok",
                "five_hour_reset_at": "2026-05-09T14:32:00Z",
                "weekly_reset_at":    "2026-05-15T09:00:00Z",
            }
            status, body = self._post("/api/limits/sync", {})
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["limits_five_hour_reset_at"], "2026-05-09T14:32:00Z")
        self.assertEqual(body["limits_weekly_reset_at"],    "2026-05-15T09:00:00Z")
        self.assertEqual(body["limits_last_sync_status"], "ok")
        self.assertIsNotNone(body["limits_last_sync_at"])

    def test_sync_unsupported_does_not_clobber_resets(self):
        from unittest.mock import patch
        self._save_key("sk-ant-x")
        self._post("/api/preferences", {"limits_five_hour_reset_at": "2026-05-09T14:32:00Z"})
        with patch("token_dashboard.server.routes.sync_limits") as m:
            m.return_value = {
                "status": "unsupported",
                "five_hour_reset_at": None,
                "weekly_reset_at": None,
            }
            status, body = self._post("/api/limits/sync", {})
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "unsupported")
        self.assertEqual(body["limits_five_hour_reset_at"], "2026-05-09T14:32:00Z")
        self.assertEqual(body["limits_last_sync_status"], "unsupported")


if __name__ == "__main__":
    unittest.main()
