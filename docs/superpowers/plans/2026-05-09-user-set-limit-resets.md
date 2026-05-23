# User-set 5h and weekly limit reset times — Implementation Plan

> **Status (2026-05-21): SHIPPED — but not via this plan.** The feature was implemented in the Rust + Tauri rewrite (v4.0+), not in the Python codebase this plan targets. See `crates/token-dashboard-core/src/preferences.rs`, `crates/token-dashboard-core/src/limits.rs`, and the `/api/limits/sync` route in `crates/token-dashboard-cli/src/routes.rs`. The Python-specific tasks below (`token_dashboard/preferences.py`, `urllib.request`, `unittest`) are obsolete and retained only for historical reference. Do not execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual datetime-picker overrides for the 5h and weekly limit reset times, plus an opt-in "Sync from Anthropic" path that reads `anthropic-ratelimit-unified-{5h,7d}-reset` headers from a single throwaway `messages` request.

**Architecture:** Two new preference key groups in the existing `plan` k/v table (no migration). `_api_limits` reads the overrides, rolls past timestamps forward, and uses them to compute `(reset - period, reset)` windows. A new server route `POST /api/limits/sync` makes one stdlib `urllib.request` call, parses the headers, and persists the result. A new React card in Settings exposes both flows.

**Tech Stack:** Python 3 stdlib (no new dependencies); React 18 + esbuild; SQLite via the project's existing `connect()` helper; `unittest` + `unittest.mock` for tests.

**Spec:** [docs/superpowers/specs/2026-05-09-user-set-limit-resets-design.md](../specs/2026-05-09-user-set-limit-resets-design.md)

**Verification (run after each task):**
```bash
python3 -m unittest discover tests
```

---

## Task 1: Preferences — reset getters/setters

**Files:**
- Modify: `token_dashboard/preferences.py`
- Modify: `tests/test_server.py` (add `PreferencesUnitTests` class)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
import datetime as _dt

from token_dashboard.preferences import (
    LIMIT_RESET_KEYS,
    get_limit_reset_at,
    set_limit_reset_at,
)


class PreferencesResetUnitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_default_is_none(self):
        for k in LIMIT_RESET_KEYS:
            self.assertIsNone(get_limit_reset_at(self.db, k))

    def test_set_and_get_roundtrip(self):
        for k in LIMIT_RESET_KEYS:
            v = set_limit_reset_at(self.db, k, "2026-05-09T14:32:00Z")
            self.assertEqual(v, "2026-05-09T14:32:00Z")
            self.assertEqual(get_limit_reset_at(self.db, k), "2026-05-09T14:32:00Z")

    def test_naive_iso_assumes_utc(self):
        v = set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00")
        self.assertEqual(v, "2026-05-09T14:32:00Z")

    def test_clear_with_none_or_empty(self):
        set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00Z")
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", None))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))
        set_limit_reset_at(self.db, "limits_five_hour_reset_at", "2026-05-09T14:32:00Z")
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", ""))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))

    def test_invalid_iso_rejected(self):
        self.assertIsNone(set_limit_reset_at(self.db, "limits_five_hour_reset_at", "not-a-date"))
        self.assertIsNone(get_limit_reset_at(self.db, "limits_five_hour_reset_at"))

    def test_invalid_key_rejected(self):
        self.assertIsNone(set_limit_reset_at(self.db, "bogus_key", "2026-05-09T14:32:00Z"))
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m unittest tests.test_server.PreferencesResetUnitTests -v
```

Expected: ImportError or AttributeError on `LIMIT_RESET_KEYS` / `get_limit_reset_at` / `set_limit_reset_at`.

- [ ] **Step 3: Implement the helpers**

Append to `token_dashboard/preferences.py`:

```python
from datetime import datetime, timezone

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m unittest tests.test_server.PreferencesResetUnitTests -v
python3 -m unittest discover tests
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add token_dashboard/preferences.py tests/test_server.py
git commit -m "preferences: add limit-reset get/set with ISO normalization"
```

---

## Task 2: Preferences — API key + sync meta

**Files:**
- Modify: `token_dashboard/preferences.py`
- Modify: `tests/test_server.py` (extend `PreferencesResetUnitTests` or add new class)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
from token_dashboard.preferences import (
    get_anthropic_api_key,
    set_anthropic_api_key,
    get_limits_sync_meta,
    set_limits_sync_meta,
)


class PreferencesApiKeyAndSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_api_key_default_none(self):
        self.assertIsNone(get_anthropic_api_key(self.db))

    def test_api_key_roundtrip_and_clear(self):
        v = set_anthropic_api_key(self.db, "sk-ant-test-123")
        self.assertEqual(v, "sk-ant-test-123")
        self.assertEqual(get_anthropic_api_key(self.db), "sk-ant-test-123")
        self.assertIsNone(set_anthropic_api_key(self.db, None))
        self.assertIsNone(get_anthropic_api_key(self.db))
        set_anthropic_api_key(self.db, "sk-ant-test-456")
        self.assertIsNone(set_anthropic_api_key(self.db, ""))
        self.assertIsNone(get_anthropic_api_key(self.db))

    def test_sync_meta_default(self):
        meta = get_limits_sync_meta(self.db)
        self.assertEqual(meta, {"last_sync_at": None, "last_sync_status": None})

    def test_sync_meta_persist(self):
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m unittest tests.test_server.PreferencesApiKeyAndSyncTests -v
```

Expected: ImportError on the four new names.

- [ ] **Step 3: Implement the helpers**

Append to `token_dashboard/preferences.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m unittest tests.test_server.PreferencesApiKeyAndSyncTests -v
python3 -m unittest discover tests
```

- [ ] **Step 5: Commit**

```bash
git add token_dashboard/preferences.py tests/test_server.py
git commit -m "preferences: add anthropic_api_key + sync metadata"
```

---

## Task 3: `anthropic_sync` module — header parsing + transport

**Files:**
- Create: `token_dashboard/anthropic_sync.py`
- Create: `tests/test_anthropic_sync.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_anthropic_sync.py`:

```python
import io
import unittest
import urllib.error
from unittest.mock import patch

from token_dashboard.anthropic_sync import sync_limits


class _FakeResponse:
    def __init__(self, headers):
        self.headers = headers
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b"{}"


class AnthropicSyncTests(unittest.TestCase):
    def test_ok_with_unified_headers(self):
        headers = {
            "anthropic-ratelimit-unified-5h-reset": "1715260320",     # 2024-05-09T13:12:00Z
            "anthropic-ratelimit-unified-7d-reset": "1715692800",     # 2024-05-14T13:20:00Z
            "anthropic-ratelimit-requests-remaining": "499",
        }
        with patch("token_dashboard.anthropic_sync.urllib.request.urlopen", return_value=_FakeResponse(headers)):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["five_hour_reset_at"], "2024-05-09T13:12:00Z")
        self.assertEqual(out["weekly_reset_at"], "2024-05-14T13:20:00Z")

    def test_unsupported_when_no_unified_headers(self):
        headers = {"anthropic-ratelimit-requests-remaining": "499"}
        with patch("token_dashboard.anthropic_sync.urllib.request.urlopen", return_value=_FakeResponse(headers)):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "unsupported")
        self.assertIsNone(out["five_hour_reset_at"])
        self.assertIsNone(out["weekly_reset_at"])

    def test_url_error_returned_as_status(self):
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=urllib.error.URLError("boom"),
        ):
            out = sync_limits("sk-ant-test")
        self.assertTrue(out["status"].startswith("error:"))
        self.assertIsNone(out["five_hour_reset_at"])

    def test_http_429_still_parses_headers(self):
        headers = {"anthropic-ratelimit-unified-5h-reset": "1715260320"}
        err = urllib.error.HTTPError(
            url="https://api.anthropic.com/v1/messages",
            code=429, msg="rate limited", hdrs=headers, fp=io.BytesIO(b""),
        )
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=err,
        ):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["five_hour_reset_at"], "2024-05-09T13:12:00Z")

    def test_http_401_returns_error(self):
        err = urllib.error.HTTPError(
            url="https://api.anthropic.com/v1/messages",
            code=401, msg="unauthorized", hdrs={}, fp=io.BytesIO(b""),
        )
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=err,
        ):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "error:http 401")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m unittest tests.test_anthropic_sync -v
```

Expected: ModuleNotFoundError on `token_dashboard.anthropic_sync`.

- [ ] **Step 3: Implement the module**

Create `token_dashboard/anthropic_sync.py`:

```python
"""One-shot probe of Anthropic's Messages API to read rate-limit headers.

Stdlib-only. Used by the user-initiated `POST /api/limits/sync` route. The
unified 5h/7d reset headers only appear on accounts on usage-based limits
(Max plan / Claude Code subscriptions); on other accounts we report
`unsupported` and leave the manually-entered reset values alone.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
PROBE_MODEL = "claude-haiku-4-5-20251001"
TIMEOUT_S = 10

UNIFIED_5H_HEADER = "anthropic-ratelimit-unified-5h-reset"
UNIFIED_7D_HEADER = "anthropic-ratelimit-unified-7d-reset"


def _unix_to_iso(value) -> "str | None":
    if value is None:
        return None
    try:
        secs = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return (
        datetime.fromtimestamp(secs, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _lower_headers(hdrs) -> dict:
    if not hdrs:
        return {}
    if hasattr(hdrs, "items"):
        return {str(k).lower(): str(v) for k, v in hdrs.items()}
    return {str(k).lower(): str(v) for k, v in (hdrs or [])}


def sync_limits(api_key: str) -> dict:
    body = json.dumps({
        "model": PROBE_MODEL,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
    )
    headers: dict = {}
    error_status: "str | None" = None
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            headers = _lower_headers(resp.headers)
            try:
                resp.read()
            except Exception:
                pass
    except urllib.error.HTTPError as e:
        headers = _lower_headers(e.headers)
        if e.code != 429:
            # 429 is fine — body got rate-limited but headers still tell us reset times.
            error_status = f"error:http {e.code}"
    except Exception as e:
        return {
            "status": f"error:{type(e).__name__}",
            "five_hour_reset_at": None,
            "weekly_reset_at": None,
        }

    five = _unix_to_iso(headers.get(UNIFIED_5H_HEADER))
    week = _unix_to_iso(headers.get(UNIFIED_7D_HEADER))

    if five is None and week is None:
        return {
            "status": error_status or "unsupported",
            "five_hour_reset_at": None,
            "weekly_reset_at": None,
        }

    return {
        "status": "ok",
        "five_hour_reset_at": five,
        "weekly_reset_at": week,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m unittest tests.test_anthropic_sync -v
python3 -m unittest discover tests
```

- [ ] **Step 5: Commit**

```bash
git add token_dashboard/anthropic_sync.py tests/test_anthropic_sync.py
git commit -m "anthropic_sync: probe Messages API for unified rate-limit headers"
```

---

## Task 4: `_api_limits` — 5h override branch + roll-forward

**Files:**
- Modify: `token_dashboard/server/routes.py:633-669` (replace `_api_limits` body)
- Modify: `tests/test_server.py` (new `LimitsOverrideTests`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
from datetime import datetime, timedelta, timezone


class LimitsOverrideTests(unittest.TestCase):
    """Drives _api_limits via HTTP for the 5h override path."""

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
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, "
                "input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) "
                "VALUES (?, NULL, 's', 'p', 'assistant', ?, 'claude-sonnet-4-6', ?, 0, 0, 0, 0)",
                (f"u-{ts_iso}", ts_iso, billable_in),
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
        # Plan = pro so caps exist
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
        # Out-of-window message must not be counted.
        self.assertLess(body["five_hour"]["used"], 99999)
        self.assertGreaterEqual(body["five_hour"]["used"], 2000)

    def test_5h_override_in_past_rolls_forward(self):
        self._set_plan_kv("plan", "pro")
        past = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(microsecond=0)
        past_iso = past.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_five_hour_reset_at", past_iso)
        body = self._get_limits()
        new_reset = body["five_hour"]["resets_at"]
        self.assertNotEqual(new_reset, past_iso)
        self.assertEqual(self._get_kv("limits_five_hour_reset_at"), new_reset)
        # Rolled forward by exactly 5h once (since past was -2h, new should be +3h).
        new_dt = datetime.fromisoformat(new_reset.replace("Z", "+00:00"))
        self.assertGreater(new_dt, datetime.now(timezone.utc))
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m unittest tests.test_server.LimitsOverrideTests -v
```

Expected: failures because `_api_limits` doesn't yet honor `limits_five_hour_reset_at`.

- [ ] **Step 3: Update `_api_limits`**

Replace the function body in `token_dashboard/server/routes.py` (currently lines 633-669). Add a helper above it:

```python
from ..preferences import (
    get_limit_reset_at,
    set_limit_reset_at,
)

_FIVE_H = timedelta(hours=5)
_SEVEN_D = timedelta(days=7)


def _roll_forward(reset_dt: datetime, now: datetime, period: timedelta) -> datetime:
    """Advance `reset_dt` by `period` until it's strictly after `now`."""
    while reset_dt <= now:
        reset_dt += period
    return reset_dt


def _resolve_override(db_path, key: str, now: datetime, period: timedelta) -> "datetime | None":
    raw = get_limit_reset_at(db_path, key)
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    rolled = _roll_forward(dt, now, period)
    if rolled.isoformat().replace("+00:00", "Z") != raw:
        set_limit_reset_at(db_path, key, rolled.isoformat().replace("+00:00", "Z"))
    return rolled
```

Then replace `_api_limits`:

```python
def _api_limits(handler, db_path, pricing, qs):
    """Token budget remaining in the active 5h session and rolling 7d window.

    Honors user-set overrides in `limits_five_hour_reset_at` and
    `limits_weekly_reset_at` when present (rolling them forward as time
    passes); otherwise falls back to the auto-anchor for 5h and a rolling
    `now-7d` slice for weekly.
    """
    plan = get_plan(db_path)
    caps = (pricing.get("limits") or {}).get(plan) or {"five_hour": None, "weekly": None}
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat().replace("+00:00", "Z")

    # ---- 5h window ----
    override_5h = _resolve_override(db_path, "limits_five_hour_reset_at", now, _FIVE_H)
    if override_5h is not None:
        anchor_dt = override_5h - _FIVE_H
        anchor_iso = anchor_dt.isoformat().replace("+00:00", "Z")
        used_5h = window_billable_tokens(db_path, anchor_iso, pricing)
        resets_at_iso = override_5h.isoformat().replace("+00:00", "Z")
    else:
        anchor_iso = current_session_anchor(db_path, now_iso)
        if anchor_iso is None:
            used_5h = 0
            resets_at_iso = None
        else:
            used_5h = window_billable_tokens(db_path, anchor_iso, pricing)
            anchor_dt = datetime.fromisoformat(anchor_iso.replace("Z", "+00:00"))
            resets_at_iso = (anchor_dt + _FIVE_H).isoformat().replace("+00:00", "Z")

    five_hour = _window_payload(used_5h, caps.get("five_hour"))
    five_hour["anchor"] = anchor_iso
    five_hour["resets_at"] = resets_at_iso

    # ---- weekly window ----
    override_week = _resolve_override(db_path, "limits_weekly_reset_at", now, _SEVEN_D)
    if override_week is not None:
        since_week = (override_week - _SEVEN_D).isoformat().replace("+00:00", "Z")
        weekly_resets_at = override_week.isoformat().replace("+00:00", "Z")
    else:
        since_week = (now - _SEVEN_D).isoformat().replace("+00:00", "Z")
        weekly_resets_at = None

    used_week = window_billable_tokens(db_path, since_week, pricing)
    weekly = _window_payload(used_week, caps.get("weekly"))
    weekly["resets_at"] = weekly_resets_at

    send_json(handler, {
        "plan": plan,
        "approximate": True,
        "meta": pricing.get("limits_meta") or {},
        "five_hour": five_hour,
        "weekly": weekly,
    })
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m unittest tests.test_server.LimitsOverrideTests -v
python3 -m unittest discover tests
```

- [ ] **Step 5: Commit**

```bash
git add token_dashboard/server/routes.py tests/test_server.py
git commit -m "limits: honor user-set 5h override with roll-forward"
```

---

## Task 5: `_api_limits` — weekly override + `weekly.resets_at` field

(The implementation from Task 4 already covers weekly; this task locks it in with explicit tests.)

**Files:**
- Modify: `tests/test_server.py` (extend `LimitsOverrideTests`)

- [ ] **Step 1: Write the failing tests**

Append to `LimitsOverrideTests` in `tests/test_server.py`:

```python
    def test_weekly_override_sets_resets_at(self):
        self._set_plan_kv("plan", "pro")
        future = (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0)
        future_iso = future.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_weekly_reset_at", future_iso)
        body = self._get_limits()
        self.assertEqual(body["weekly"]["resets_at"], future_iso)

    def test_weekly_override_in_past_rolls_forward_by_seven_days(self):
        self._set_plan_kv("plan", "pro")
        past = (datetime.now(timezone.utc) - timedelta(days=3)).replace(microsecond=0)
        past_iso = past.isoformat().replace("+00:00", "Z")
        self._set_plan_kv("limits_weekly_reset_at", past_iso)
        body = self._get_limits()
        rolled = body["weekly"]["resets_at"]
        rolled_dt = datetime.fromisoformat(rolled.replace("Z", "+00:00"))
        self.assertGreater(rolled_dt, datetime.now(timezone.utc))
        self.assertEqual(self._get_kv("limits_weekly_reset_at"), rolled)

    def test_weekly_no_override_resets_at_is_none(self):
        body = self._get_limits()
        self.assertIn("resets_at", body["weekly"])
        self.assertIsNone(body["weekly"]["resets_at"])
```

- [ ] **Step 2: Run tests**

```bash
python3 -m unittest tests.test_server.LimitsOverrideTests -v
```

Expected: pass (Task 4 already implemented this).

- [ ] **Step 3: Commit**

```bash
git add tests/test_server.py
git commit -m "tests: lock in weekly override + weekly.resets_at field"
```

---

## Task 6: `/api/preferences` — surface new keys

**Files:**
- Modify: `token_dashboard/server/routes.py` (the `_api_preferences_get` and `_api_preferences_post` handlers — locate via `grep -n "/api/preferences" token_dashboard/server/routes.py`)
- Modify: `tests/test_server.py` (extend `ServerTests`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
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
        # set then clear
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
        # GET response body must not contain the secret string anywhere.
        self.assertNotIn("sk-ant-secret", json.dumps(body))

    def test_preferences_sync_meta_default_null(self):
        body = json.loads(self._get("/api/preferences"))
        self.assertIsNone(body["limits_last_sync_at"])
        self.assertIsNone(body["limits_last_sync_status"])
```

- [ ] **Step 2: Locate and update the handlers**

Run:
```bash
grep -n "preferences" token_dashboard/server/routes.py | head -40
```

Find the GET handler that returns the preferences dict and add these fields. Sample patch (adapt to existing structure):

```python
# In the preferences GET handler, after the existing fields:
from ..preferences import (
    get_limit_reset_at,
    LIMIT_RESET_KEYS,
    get_anthropic_api_key,
    get_limits_sync_meta,
)

# inside the GET handler:
out["limits_five_hour_reset_at"] = get_limit_reset_at(db_path, "limits_five_hour_reset_at")
out["limits_weekly_reset_at"]    = get_limit_reset_at(db_path, "limits_weekly_reset_at")
out["anthropic_api_key_set"]     = get_anthropic_api_key(db_path) is not None
meta = get_limits_sync_meta(db_path)
out["limits_last_sync_at"]       = meta["last_sync_at"]
out["limits_last_sync_status"]   = meta["last_sync_status"]
```

In the POST handler, alongside the existing key handling:

```python
from ..preferences import (
    set_limit_reset_at,
    set_anthropic_api_key,
    LIMIT_RESET_KEYS,
)

for k in LIMIT_RESET_KEYS:
    if k in body:
        set_limit_reset_at(db_path, k, body[k])

if "anthropic_api_key" in body:
    set_anthropic_api_key(db_path, body["anthropic_api_key"])
```

- [ ] **Step 3: Run tests**

```bash
python3 -m unittest tests.test_server.ServerTests -v
python3 -m unittest discover tests
```

- [ ] **Step 4: Commit**

```bash
git add token_dashboard/server/routes.py tests/test_server.py
git commit -m "api: surface reset keys + masked api_key_set in /api/preferences"
```

---

## Task 7: `POST /api/limits/sync` route

**Files:**
- Modify: `token_dashboard/server/routes.py` (register new POST route)
- Modify: `tests/test_server.py` (new `LimitsSyncRouteTests`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
from unittest.mock import patch


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
        status, body = self._post("/api/limits/sync", {})
        self.assertEqual(status, 400)

    def test_sync_ok_persists_resets_and_meta(self):
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
        self._save_key("sk-ant-x")
        # Pre-set a manual reset; unsupported sync must leave it alone.
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m unittest tests.test_server.LimitsSyncRouteTests -v
```

Expected: 404s on `POST /api/limits/sync`.

- [ ] **Step 3: Implement the route**

In `token_dashboard/server/routes.py`:

```python
from datetime import datetime, timezone
from ..anthropic_sync import sync_limits
from ..preferences import (
    get_anthropic_api_key,
    set_limit_reset_at,
    set_limits_sync_meta,
    get_limit_reset_at,
    get_limits_sync_meta,
)


def _api_limits_sync(handler, db_path, pricing, qs):
    api_key = get_anthropic_api_key(db_path)
    if not api_key:
        send_json(handler, {"error": "no api key saved"}, status=400)
        return
    result = sync_limits(api_key)
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    set_limits_sync_meta(db_path, status=result["status"], at_iso=now_iso)
    if result["status"] == "ok":
        if result["five_hour_reset_at"]:
            set_limit_reset_at(db_path, "limits_five_hour_reset_at", result["five_hour_reset_at"])
        if result["weekly_reset_at"]:
            set_limit_reset_at(db_path, "limits_weekly_reset_at", result["weekly_reset_at"])
    meta = get_limits_sync_meta(db_path)
    send_json(handler, {
        "status": result["status"],
        "limits_five_hour_reset_at": get_limit_reset_at(db_path, "limits_five_hour_reset_at"),
        "limits_weekly_reset_at":    get_limit_reset_at(db_path, "limits_weekly_reset_at"),
        "limits_last_sync_at":       meta["last_sync_at"],
        "limits_last_sync_status":   meta["last_sync_status"],
    })
```

Register the new route in the POST routes table (locate `POST_ROUTES` near the bottom of the file):

```python
POST_ROUTES["/api/limits/sync"] = _api_limits_sync
```

If the existing dispatcher uses a different shape, follow the file's pattern (e.g., a shared `ROUTES` dict keyed by `(method, path)`). The grep:

```bash
grep -n "POST_ROUTES\|GET_ROUTES\|api/preferences" token_dashboard/server/routes.py
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m unittest tests.test_server.LimitsSyncRouteTests -v
python3 -m unittest discover tests
```

- [ ] **Step 5: Commit**

```bash
git add token_dashboard/server/routes.py tests/test_server.py
git commit -m "api: POST /api/limits/sync — persist results and meta"
```

---

## Task 8: Frontend `LimitResetCard` — manual fields

**Files:**
- Modify: `frontend/src/routes/settings.jsx`

- [ ] **Step 1: Add the component**

Insert after the `LimitsToggleCard` definition (around line 301), before `BUDGET_FIELDS`:

```jsx
// ---------- limit reset times (manual + sync) ----------

const _isoToLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const _localInputToIso = (local) => {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

const RESET_FIELDS = [
  { key: "limits_five_hour_reset_at", label: "Next 5h reset",     note: "datetime when your active 5h window ends" },
  { key: "limits_weekly_reset_at",    label: "Next weekly reset", note: "datetime when your weekly window ends" },
];

const LimitResetCard = () => {
  const [drafts, setDrafts] = useState({ limits_five_hour_reset_at: "", limits_weekly_reset_at: "" });
  const [server, setServer] = useState({ limits_five_hour_reset_at: null, limits_weekly_reset_at: null });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = async () => {
    try {
      const r = await fetch("/api/preferences", { cache: "no-store" });
      const d = await r.json();
      const next = {
        limits_five_hour_reset_at: d.limits_five_hour_reset_at || null,
        limits_weekly_reset_at:    d.limits_weekly_reset_at    || null,
      };
      setServer(next);
      setDrafts({
        limits_five_hour_reset_at: _isoToLocalInput(next.limits_five_hour_reset_at),
        limits_weekly_reset_at:    _isoToLocalInput(next.limits_weekly_reset_at),
      });
    } catch (_) {}
    setLoaded(true);
  };

  useEffect(() => { reload(); }, []);

  const persist = async (key, value) => {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      await reload();
    } catch (_) {}
    setSaving(false);
  };

  const onCommit = (key) => {
    const draft = drafts[key];
    const iso = draft ? _localInputToIso(draft) : null;
    if (iso === server[key]) return;
    persist(key, iso);
  };

  const onClear = (key) => {
    setDrafts((d) => ({ ...d, [key]: "" }));
    persist(key, null);
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Limit reset times</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? "override the dashboard's auto estimate" : "loading…")}</span>
      </div>
      <div className="a-budget-grid">
        {RESET_FIELDS.map((f) => (
          <label key={f.key} className="a-budget-field">
            <div className="a-plan-title">{f.label}</div>
            <div className="a-plan-note">{f.note}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input
                type="datetime-local"
                value={drafts[f.key]}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => onCommit(f.key)}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              />
              {server[f.key] && (
                <button type="button" className="a-pill-btn" onClick={() => onClear(f.key)}>
                  Clear
                </button>
              )}
            </div>
          </label>
        ))}
      </div>
    </section>
  );
};
```

- [ ] **Step 2: Wire it into the layout**

In the `Settings` component's render, inside the `Limits & alerts` `SettingsGroup`, after `<BadgeCard ... />`:

```jsx
<SettingsGroup title="Limits &amp; alerts" description="rolling-window estimates and the dock/menubar indicator">
  <LimitsToggleCard enabled={limitsEnabled} onChange={onToggleLimits} loaded={limitsLoaded} saving={limitsSaving} />
  <BadgeCard limitsEnabled={limitsEnabled} />
  {limitsEnabled && <LimitResetCard />}
</SettingsGroup>
```

- [ ] **Step 3: Build and smoke-test**

```bash
cd frontend
npm run build
cd ..
python3 cli.py dashboard --no-open
# In another shell:
curl -s http://127.0.0.1:8080/api/preferences | python3 -m json.tool
```

Open `http://127.0.0.1:8080/`, toggle "Show 5h and weekly window usage" on, set a future datetime in each field, blur the field, and confirm:
- Network tab shows `POST /api/preferences` with the ISO body.
- A subsequent `GET /api/preferences` returns the value.
- Overview's "Plan limits" card uses the new `resets_at`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/settings.jsx frontend/dist/app.js
git commit -m "frontend: add Limit reset times card with datetime pickers"
```

---

## Task 9: Frontend `LimitResetCard` — sync section

**Files:**
- Modify: `frontend/src/routes/settings.jsx` (extend `LimitResetCard`)

- [ ] **Step 1: Add sync state and UI to the existing card**

Inside `LimitResetCard`, add state above the `return`:

```jsx
const [apiKeyDraft, setApiKeyDraft] = useState("");
const [keySet, setKeySet] = useState(false);
const [lastSyncAt, setLastSyncAt] = useState(null);
const [lastSyncStatus, setLastSyncStatus] = useState(null);
const [syncing, setSyncing] = useState(false);
```

Update `reload` to populate them:

```jsx
setKeySet(!!d.anthropic_api_key_set);
setLastSyncAt(d.limits_last_sync_at || null);
setLastSyncStatus(d.limits_last_sync_status || null);
```

Add handlers:

```jsx
const onSaveKey = async () => {
  if (!apiKeyDraft.trim()) return;
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anthropic_api_key: apiKeyDraft.trim() }),
  });
  setApiKeyDraft("");
  reload();
};

const onForgetKey = async () => {
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anthropic_api_key: null }),
  });
  reload();
};

const onSyncNow = async () => {
  setSyncing(true);
  try {
    const r = await fetch("/api/limits/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    setLastSyncStatus(d.limits_last_sync_status || d.status || null);
    setLastSyncAt(d.limits_last_sync_at || null);
    if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    await reload();
  } catch (_) {}
  setSyncing(false);
};
```

Append to the JSX (inside the same `<section>`, after the `RESET_FIELDS` map):

```jsx
<div className="a-card-divider" />
<div className="a-label" style={{ marginBottom: 8 }}>Sync from Anthropic (optional)</div>
{!keySet ? (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <input
      type="password"
      placeholder="sk-ant-…"
      autoComplete="off"
      value={apiKeyDraft}
      onChange={(e) => setApiKeyDraft(e.target.value)}
      style={{ flex: 1, minWidth: 240 }}
    />
    <button type="button" className="a-pill-btn" onClick={onSaveKey} disabled={!apiKeyDraft.trim()}>
      Save key
    </button>
  </div>
) : (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <span className="a-card-meta">API key saved · stored locally</span>
    <button type="button" className="a-pill-btn" onClick={onForgetKey}>Forget</button>
    <button type="button" className="a-pill-btn" onClick={onSyncNow} disabled={syncing}>
      {syncing ? "syncing…" : "Sync now"}
    </button>
  </div>
)}
{lastSyncStatus && (
  <div className={`a-card-meta ${lastSyncStatus === "ok" ? "tone-good" : lastSyncStatus.startsWith("error") ? "tone-bad" : ""}`} style={{ marginTop: 8 }}>
    {lastSyncStatus === "ok" && `Synced ${lastSyncAt ? new Date(lastSyncAt).toLocaleString() : ""} — values populated above`}
    {lastSyncStatus === "unsupported" && "This account does not expose unified-window resets — use manual entry above."}
    {lastSyncStatus.startsWith("error") && `Sync failed: ${lastSyncStatus.slice(6)}`}
  </div>
)}
```

- [ ] **Step 2: Build and smoke-test**

```bash
cd frontend && npm run build && cd ..
python3 cli.py dashboard --no-open
```

Open Settings, paste a fake key, click Save. Click "Sync now" — server should hit `https://api.anthropic.com` with that key. With a real key (Max plan), expect `Synced …` and the manual fields to populate. Without unified headers, expect the `unsupported` line.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/settings.jsx frontend/dist/app.js
git commit -m "frontend: add Anthropic sync section to Limit reset times"
```

---

## Task 10: `CLAUDE.md` exception note

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the note**

In the `## Conventions` section, replace the "Fully local." line:

```markdown
- **Fully local.** No telemetry, no remote calls for user data. Tests run offline. **Exception:** the user-initiated `POST /api/limits/sync` route makes one Anthropic API call with the user's saved key to read rate-limit headers; this is opt-in, never automatic, and disabled until the user saves a key in Settings.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note the user-initiated remote-call exception"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

```bash
python3 -m unittest discover tests
```

Expected: all green, ≥ original 68 tests + new ones (~85 total).

- [ ] **Step 2: Manual smoke test**

```bash
python3 cli.py dashboard --no-open
```

Open `http://127.0.0.1:8080/#/settings`:
1. Toggle "Show 5h and weekly window usage" on.
2. Set future "Next 5h reset" datetime; navigate to Overview; confirm the "Plan limits" card shows the new `resets_at`.
3. Clear the field; confirm Overview reverts to the auto-anchor.
4. Save a fake API key; click Sync now; observe `error:http 401` (or similar — fake key).
5. Click Forget; confirm the input reappears.

- [ ] **Step 3: Final commit (if any leftovers)**

```bash
git status
git log --oneline -12
```

---

## Self-review

**Spec coverage:**
- Manual datetime overrides → Tasks 1, 4, 5, 8.
- Roll-forward logic → Task 4 (`_resolve_override` helper, tested in Tasks 4 & 5).
- API key storage + sync meta → Task 2.
- `anthropic_sync` module → Task 3.
- `/api/preferences` surface (incl. masked key) → Task 6.
- `POST /api/limits/sync` → Task 7.
- Frontend manual + sync UI → Tasks 8, 9.
- CLAUDE.md exception → Task 10.
- Security: 127.0.0.1 default unchanged; key never returned in GET (Task 6 test), never logged (Task 3 module never logs).

**Placeholder scan:** none. Every step has concrete code or a concrete command.

**Type consistency:** `LIMIT_RESET_KEYS`, `_FIVE_H` / `_SEVEN_D`, `_resolve_override`, `sync_limits`, `_api_limits_sync` — used identically in every task that references them. JSON keys (`limits_five_hour_reset_at`, `limits_weekly_reset_at`, `anthropic_api_key`, `anthropic_api_key_set`, `limits_last_sync_at`, `limits_last_sync_status`) are spelled the same in spec, backend, tests, and frontend.

---
