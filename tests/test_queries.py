import os
import tempfile
import unittest

from token_dashboard.db import (
    init_db, connect,
    overview_totals, expensive_prompts, project_summary,
    tool_token_breakdown, recent_sessions, session_turns,
    daily_token_breakdown, model_breakdown, project_name_for,
    skill_breakdown, current_session_anchor,
)
from token_dashboard.db.queries import window_billable_tokens


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "q.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
              prompt_text, prompt_chars)
            VALUES
              ('u1',NULL,'s1','projA','user','2026-04-10T00:00:00Z',NULL,0,0,0,0,0,'big prompt',10),
              ('a1','u1','s1','projA','assistant','2026-04-10T00:00:01Z','claude-opus-4-7',100,200,300,0,0,NULL,NULL),
              ('u2',NULL,'s2','projB','user','2026-04-11T00:00:00Z',NULL,0,0,0,0,0,'small',5),
              ('a2','u2','s2','projB','assistant','2026-04-11T00:00:01Z','claude-sonnet-4-6',5,5,0,0,0,NULL,NULL);
            INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, timestamp, is_error)
            VALUES ('a1','s1','projA','Read','foo.py','tu-read-1',NULL,'2026-04-10T00:00:01Z',0),
                   ('a1','s1','projA','Bash','npm test','tu-bash-1',NULL,'2026-04-10T00:00:01Z',0),
                   ('u2','s1','projA','_tool_result','tu-read-1','tu-read-1',400,'2026-04-10T00:00:02Z',0),
                   ('u2','s1','projA','_tool_result','tu-bash-1','tu-bash-1',1500,'2026-04-10T00:00:02Z',0);
            """)
            c.commit()

    def test_overview_totals(self):
        t = overview_totals(self.db, since=None, until=None)
        self.assertEqual(t["sessions"], 2)
        self.assertEqual(t["turns"], 2)
        self.assertEqual(t["input_tokens"], 105)
        self.assertEqual(t["output_tokens"], 205)

    def test_expensive_prompts_orders_by_tokens(self):
        rows = expensive_prompts(self.db, limit=10)
        self.assertGreaterEqual(len(rows), 2)
        self.assertEqual(rows[0]["prompt_text"], "big prompt")

    def test_expensive_prompts_sort_recent(self):
        rows = expensive_prompts(self.db, limit=10, sort="recent")
        self.assertEqual(rows[0]["prompt_text"], "small")
        self.assertEqual(rows[1]["prompt_text"], "big prompt")

    def test_project_summary_groups(self):
        rows = project_summary(self.db)
        slugs = {r["project_slug"]: r for r in rows}
        self.assertIn("projA", slugs)
        self.assertEqual(slugs["projA"]["turns"], 1)

    def test_tool_breakdown(self):
        rows = tool_token_breakdown(self.db)
        names = {r["tool_name"]: r for r in rows}
        self.assertIn("Read", names)
        self.assertIn("Bash", names)
        self.assertEqual(names["Read"]["result_tokens"], 400)
        self.assertEqual(names["Bash"]["result_tokens"], 1500)
        self.assertNotIn("_tool_result", names)

    def test_recent_sessions(self):
        rows = recent_sessions(self.db, limit=5)
        self.assertEqual(rows[0]["session_id"], "s2")

    def test_session_turns(self):
        rows = session_turns(self.db, "s1")
        self.assertEqual(len(rows), 2)

    def test_daily_token_breakdown_groups_by_day(self):
        rows = daily_token_breakdown(self.db)
        days = {r["day"]: r for r in rows}
        self.assertIn("2026-04-10", days)
        self.assertIn("2026-04-11", days)
        self.assertEqual(days["2026-04-10"]["input_tokens"], 100)
        self.assertEqual(days["2026-04-10"]["output_tokens"], 200)
        self.assertEqual(days["2026-04-10"]["cache_read_tokens"], 300)

    def test_daily_token_breakdown_respects_since(self):
        rows = daily_token_breakdown(self.db, since="2026-04-11T00:00:00Z")
        days = [r["day"] for r in rows]
        self.assertEqual(days, ["2026-04-11"])

    def test_model_breakdown_respects_since_and_groups(self):
        rows = model_breakdown(self.db)
        models = {r["model"]: r for r in rows}
        self.assertIn("claude-opus-4-7", models)
        self.assertIn("claude-sonnet-4-6", models)
        self.assertEqual(models["claude-opus-4-7"]["input_tokens"], 100)

        filtered = model_breakdown(self.db, since="2026-04-11T00:00:00Z")
        names = [r["model"] for r in filtered]
        self.assertEqual(names, ["claude-sonnet-4-6"])


class SkillBreakdownTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "s.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, session_id, project_slug, type, timestamp)
            VALUES
              ('u1','s1','pA','user','2026-04-10T00:00:00Z'),
              ('a1','s1','pA','assistant','2026-04-10T00:00:01Z'),
              ('u2','s2','pA','user','2026-04-11T00:00:00Z'),
              ('a2','s2','pA','assistant','2026-04-11T00:00:01Z');

            INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, result_tokens, timestamp, is_error)
            VALUES
              ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:01Z',0),
              ('u1','s1','pA','_tool_result','use-123',500,'2026-04-10T00:00:05Z',0),
              ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:30Z',0),
              ('u1','s1','pA','_tool_result','use-124',800,'2026-04-10T00:00:32Z',0),
              ('a2','s2','pA','Skill','create-skill',NULL,'2026-04-11T00:00:01Z',0),
              ('u2','s2','pA','_tool_result','use-125',1200,'2026-04-11T00:00:02Z',0);
            """)
            c.commit()

    def test_groups_by_skill(self):
        rows = skill_breakdown(self.db)
        by_name = {r["skill"]: r for r in rows}
        self.assertEqual(by_name["brainstorming"]["invocations"], 2)
        self.assertEqual(by_name["brainstorming"]["sessions"], 1)
        self.assertEqual(by_name["create-skill"]["invocations"], 1)

    def test_orders_by_invocations(self):
        rows = skill_breakdown(self.db)
        self.assertEqual(rows[0]["skill"], "brainstorming")

    def test_respects_since(self):
        rows = skill_breakdown(self.db, since="2026-04-11T00:00:00Z")
        names = [r["skill"] for r in rows]
        self.assertEqual(names, ["create-skill"])


class ProjectNameTests(unittest.TestCase):
    def test_basename_of_posix_cwd(self):
        self.assertEqual(project_name_for("/Users/x/foo", "slug"), "foo")

    def test_basename_of_windows_cwd(self):
        self.assertEqual(
            project_name_for(r"C:\Users\alice\projects\Token Dashboard", "anything"),
            "Token Dashboard",
        )

    def test_trailing_slash_stripped(self):
        self.assertEqual(project_name_for("/a/b/c/", "slug"), "c")

    def test_fallback_uses_last_dash_segment(self):
        self.assertEqual(
            project_name_for(None, "C--Users-x-Foo-Bar"),
            "Bar",
        )

    def test_fallback_single_segment(self):
        self.assertEqual(project_name_for(None, "projA"), "projA")

    def test_empty(self):
        self.assertEqual(project_name_for(None, ""), "")

    def test_walks_up_cwd_to_project_root(self):
        # cwd is a subfolder; slug matches the parent → return the parent's basename
        self.assertEqual(
            project_name_for(
                r"C:\Users\alice\projects\MyProject\subdir",
                "C--Users-alice-projects-MyProject",
            ),
            "MyProject",
        )

    def test_walks_up_preserves_spaces(self):
        self.assertEqual(
            project_name_for(
                r"C:\Users\alice\projects\Token Dashboard\src\subdir",
                "C--Users-alice-projects-Token-Dashboard",
            ),
            "Token Dashboard",
        )


class ProjectNameInQueriesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "n.db")
        init_db(self.db)
        with connect(self.db) as c:
            c.executescript("""
            INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
            VALUES
              ('u1','s1','C--Users-x-My-Repo','/Users/x/My Repo','user','2026-04-10T00:00:00Z',0,0,0,0,0),
              ('a1','s1','C--Users-x-My-Repo','/Users/x/My Repo','assistant','2026-04-10T00:00:01Z',10,20,0,0,0),
              ('u2','s2','slugOnly',NULL,'user','2026-04-11T00:00:00Z',0,0,0,0,0),
              ('a2','s2','slugOnly',NULL,'assistant','2026-04-11T00:00:01Z',5,5,0,0,0);
            """)
            c.commit()

    def test_project_summary_uses_cwd_basename(self):
        rows = project_summary(self.db)
        names = {r["project_slug"]: r["project_name"] for r in rows}
        self.assertEqual(names["C--Users-x-My-Repo"], "My Repo")
        self.assertEqual(names["slugOnly"], "slugOnly")

    def test_recent_sessions_has_project_name(self):
        rows = recent_sessions(self.db)
        by_sid = {r["session_id"]: r for r in rows}
        self.assertEqual(by_sid["s1"]["project_name"], "My Repo")
        self.assertEqual(by_sid["s2"]["project_name"], "slugOnly")


class WorktreeNameTests(unittest.TestCase):
    def test_worktree_parent_windows(self):
        from token_dashboard.db.projects import worktree_parent_name
        self.assertEqual(
            worktree_parent_name(
                r"C:\Users\guill\Documents\git\token-dashboard\.claude\worktrees\stoic-kapitsa-5486f3"
            ),
            "token-dashboard",
        )

    def test_worktree_parent_posix_with_subdir(self):
        from token_dashboard.db.projects import worktree_parent_name
        self.assertEqual(
            worktree_parent_name(
                "/Users/x/git/Token-Dashboard/.claude/worktrees/cool-bardeen-e0c385/frontend"
            ),
            "Token-Dashboard",
        )

    def test_worktree_parent_returns_none_for_non_worktree(self):
        from token_dashboard.db.projects import worktree_parent_name
        self.assertIsNone(worktree_parent_name("/Users/x/git/foo/bar"))
        self.assertIsNone(worktree_parent_name(None))
        self.assertIsNone(worktree_parent_name(""))

    def test_best_project_name_resolves_worktree(self):
        from token_dashboard.db.projects import best_project_name
        self.assertEqual(
            best_project_name(
                [r"C:\Users\guill\Documents\git\token-dashboard\.claude\worktrees\stoic-kapitsa-5486f3"],
                "C--Users-guill-Documents-git-token-dashboard--claude-worktrees-stoic-kapitsa-5486f3",
            ),
            "token-dashboard",
        )


class WorktreeFoldTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "wf.db")
        init_db(self.db)
        parent_cwd = "/Users/x/git/Repo"
        parent_slug = "-Users-x-git-Repo"
        wt_cwd = "/Users/x/git/Repo/.claude/worktrees/jovial-lamport-ddf0f8"
        wt_slug = "-Users-x-git-Repo--claude-worktrees-jovial-lamport-ddf0f8"
        with connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("u1", "s_main", parent_slug, parent_cwd, "user",
                 "2026-04-10T00:00:00Z", 0, 0, 0, 0, 0),
            )
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("a1", "s_main", parent_slug, parent_cwd, "assistant",
                 "2026-04-10T00:00:01Z", 100, 200, 0, 0, 0),
            )
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("u2", "s_wt", wt_slug, wt_cwd, "user",
                 "2026-04-10T01:00:00Z", 0, 0, 0, 0, 0),
            )
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("a2", "s_wt", wt_slug, wt_cwd, "assistant",
                 "2026-04-10T01:00:01Z", 50, 60, 0, 0, 0),
            )
            c.commit()

    def test_project_summary_folds_worktree_into_parent(self):
        rows = project_summary(self.db)
        by_name = {r["project_name"]: r for r in rows}
        self.assertIn("Repo", by_name)
        self.assertNotIn("jovial-lamport-ddf0f8", by_name)
        agg = by_name["Repo"]
        self.assertEqual(agg["sessions"], 2)
        self.assertEqual(agg["turns"], 2)
        self.assertEqual(agg["input_tokens"], 150)
        self.assertEqual(agg["output_tokens"], 260)
        self.assertEqual(agg["billable_tokens"], 410)

    def test_recent_sessions_shows_parent_for_worktree(self):
        rows = recent_sessions(self.db, limit=10)
        by_sid = {r["session_id"]: r for r in rows}
        self.assertEqual(by_sid["s_main"]["project_name"], "Repo")
        self.assertEqual(by_sid["s_wt"]["project_name"], "Repo")


class SessionAnchorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "anchor.db")
        init_db(self.db)

    def _add(self, uuid, ts):
        with connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?, 's', 'p', 'assistant', ?, 1, 1, 0, 0, 0)",
                (uuid, ts),
            )
            c.commit()

    def test_no_messages_returns_none(self):
        self.assertIsNone(current_session_anchor(self.db, "2026-05-08T12:00:00Z"))

    def test_anchor_is_oldest_message_within_5h(self):
        self._add("a1", "2026-05-08T08:00:00Z")
        self._add("a2", "2026-05-08T09:30:00Z")
        self._add("a3", "2026-05-08T11:30:00Z")
        anchor = current_session_anchor(self.db, "2026-05-08T12:00:00Z")
        self.assertEqual(anchor, "2026-05-08T08:00:00Z")

    def test_new_session_after_5h_gap(self):
        # First session anchored at 04:00, last activity 08:00.
        self._add("a1", "2026-05-08T04:00:00Z")
        self._add("a2", "2026-05-08T07:30:00Z")
        # Next message lands AFTER 04:00 + 5h = 09:00 → new anchor.
        self._add("a3", "2026-05-08T10:00:00Z")
        self._add("a4", "2026-05-08T11:30:00Z")
        anchor = current_session_anchor(self.db, "2026-05-08T12:00:00Z")
        self.assertEqual(anchor, "2026-05-08T10:00:00Z")

    def test_session_expired_returns_none(self):
        # Last activity 6h ago, no current session.
        self._add("a1", "2026-05-08T06:00:00Z")
        anchor = current_session_anchor(self.db, "2026-05-08T12:00:00Z")
        self.assertIsNone(anchor)

    def test_does_not_use_rolling_window(self):
        # Heavy session ended >5h ago; tiny session just started. The anchor
        # must be the new session's start, not any old message.
        self._add("old1", "2026-05-08T03:00:00Z")
        self._add("old2", "2026-05-08T05:00:00Z")  # ends 03:00 + 5h = 08:00
        self._add("new1", "2026-05-08T11:30:00Z")  # > 08:00, new anchor
        anchor = current_session_anchor(self.db, "2026-05-08T12:00:00Z")
        self.assertEqual(anchor, "2026-05-08T11:30:00Z")


class WindowBillableTokensTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "wb.db")
        init_db(self.db)
        with connect(self.db) as c:
            # 100 input + 200 output = 300 billable on Opus
            # 50 input + 50 output = 100 billable on Sonnet
            # 30 input + 70 output = 100 billable on Haiku
            c.executescript("""
            INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
            VALUES
              ('o1','s','p','assistant','2026-05-08T10:00:00Z','claude-opus-4-7',  100, 200, 0, 0, 0),
              ('s1','s','p','assistant','2026-05-08T10:30:00Z','claude-sonnet-4-6', 50,  50, 0, 0, 0),
              ('h1','s','p','assistant','2026-05-08T10:45:00Z','claude-haiku-4-5',  30,  70, 0, 0, 0);
            """)
            c.commit()

    def test_unweighted_sums_raw_tokens(self):
        self.assertEqual(
            window_billable_tokens(self.db, "2026-05-08T00:00:00Z"),
            500,
        )

    def test_weighted_uses_tier_weight(self):
        pricing = {
            "models": {
                "claude-opus-4-7":   {"tier": "opus"},
                "claude-sonnet-4-6": {"tier": "sonnet"},
                "claude-haiku-4-5":  {"tier": "haiku"},
            },
            "tier_weight": {"opus": 5.0, "sonnet": 1.0, "haiku": 0.33},
        }
        # 300*5 + 100*1 + 100*0.33 = 1500 + 100 + 33 = 1633
        self.assertEqual(
            window_billable_tokens(self.db, "2026-05-08T00:00:00Z", pricing),
            1633,
        )

    def test_weighted_falls_back_to_legacy_when_no_weights(self):
        pricing = {"models": {}}  # no tier_weight key
        self.assertEqual(
            window_billable_tokens(self.db, "2026-05-08T00:00:00Z", pricing),
            500,
        )


if __name__ == "__main__":
    unittest.main()
