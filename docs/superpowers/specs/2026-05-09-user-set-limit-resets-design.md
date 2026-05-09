# User-set 5h and weekly limit reset times (hybrid: manual + sync)

**Date:** 2026-05-09
**Status:** Design approved, awaiting plan
**Scope:** Settings UI + backend preferences + `/api/limits` override + opt-in sync from Anthropic API

## Problem

The dashboard currently estimates Anthropic's rate-limit windows:

- **5h window** is auto-anchored at the first assistant message of the active session (`current_session_anchor` in `db/queries.py`). Resets 5 hours later.
- **Weekly window** is a rolling `now - 7d` slice with no real anchor.

Both estimates can drift from Anthropic's actual reset times, which depend on each user's account-level usage history (including traffic from claude.ai or other clients the dashboard doesn't read). Users who watch their real reset times in claude.ai have no way to align the dashboard.

## Goal

Let users override the next reset datetime for each window from Settings, either by hand or by syncing from Anthropic's API. When set, the dashboard treats `(reset - period, reset)` as the active window and uses that for "Plan limits remaining" cards, status indicator (badge), and any other limit-driven UI. Blank = current auto-detection behavior.

Sync path (opt-in): user enters their `ANTHROPIC_API_KEY` once and clicks **Sync now**. The server makes one minimal request to `POST /v1/messages` and reads `anthropic-ratelimit-unified-5h-reset` / `-7d-reset` from the response headers. Available only on accounts where Anthropic returns those headers (Max-plan / usage-based limits).

## Non-goals

- Background / scheduled auto-sync (manual click only — keeps API call costs visible to user).
- Per-plan or per-account multi-window tracking.
- Notification when a reset is imminent.
- Encrypting the stored API key beyond filesystem permissions on `~/.claude/token-dashboard.db`.

## Project-rule exception

`CLAUDE.md` says "Fully local. No telemetry, no remote calls for user data." The sync feature is a deliberate, opt-in remote call **for** the user's own data — not telemetry, not background, not on by default. Document this in `CLAUDE.md` ("Exceptions: explicit user-initiated sync to Anthropic's API for the user's own rate-limit headers") as part of this change.

## User-facing model

**Manual override**
- One datetime field per window: "Next 5h reset", "Next weekly reset".
- Native browser datetime picker (`<input type="datetime-local">`) — no free-form text, no parse errors at the boundary.
- Blank field = auto-detect (today's behavior). A "Clear" affordance per field.
- The picker reads/writes local time; the server stores UTC.

**Sync from Anthropic** (collapsible / secondary section in same card)
- Password-style text input for the API key, with a "Save" button. Stored in DB once saved; replaced with a "Saved · 2026-…" line + "Replace" / "Forget" affordances on subsequent visits.
- "Sync now" button — disabled until a key is saved.
- Result line shows last sync status: `Synced · 2 minutes ago — 5h resets at 14:32, weekly at Mon 09:00` or `Failed: <reason>`.
- After a successful sync, the two datetime fields above are populated with the values from the headers. User can still edit them by hand afterwards.
- If the response lacks `unified-5h-reset` / `unified-7d-reset` headers (account is not on usage-based limits), show: `Synced · this account doesn't expose unified window resets — manual entry only`.

The whole card lives in the existing "Limits & alerts" settings group, visible only when `limits_enabled` is on.

## Data flow

```
Settings (datetime-local) → POST /api/preferences {limits_five_hour_reset_at, limits_weekly_reset_at}
       │
       ▼
preferences.set_limit_reset_at(...) → plan k/v table
       │
       ▼
GET /api/limits → reads override, rolls forward if past, computes window from override
       │
       ▼
Overview "Plan limits" + status indicator badge
```

## Storage

New keys in the existing `plan` k/v table (no schema migration needed):

| Key                            | Format                  | Default |
|--------------------------------|-------------------------|---------|
| `limits_five_hour_reset_at`    | ISO 8601 UTC, `…Z`      | absent  |
| `limits_weekly_reset_at`       | ISO 8601 UTC, `…Z`      | absent  |
| `anthropic_api_key`            | string (raw)            | absent  |
| `limits_last_sync_at`          | ISO 8601 UTC, `…Z`      | absent  |
| `limits_last_sync_status`      | `ok` / `unsupported` / `error:<short>` | absent |

Absent / empty string for reset keys = use auto-detection. The API key is stored unencrypted; the DB lives at `~/.claude/token-dashboard.db` with the user's account permissions, same threat model as `~/.aws/credentials` or `~/.config/anthropic/key`.

### `preferences.py` additions (~50 LOC)

```python
LIMIT_RESET_KEYS = ("limits_five_hour_reset_at", "limits_weekly_reset_at")

def get_limit_reset_at(db_path, key) -> "str | None":
    # validate key in LIMIT_RESET_KEYS, return ISO string or None

def set_limit_reset_at(db_path, key, iso_or_none) -> "str | None":
    # accept None / "" to clear; reject unparseable; store as UTC ISO with Z suffix

def get_anthropic_api_key(db_path) -> "str | None": ...
def set_anthropic_api_key(db_path, key_or_none) -> "str | None":
    # None / "" clears; otherwise stored verbatim

def get_limits_sync_meta(db_path) -> dict:
    # returns {"last_sync_at": iso|None, "last_sync_status": str|None}

def set_limits_sync_meta(db_path, *, status: str, at_iso: str) -> None: ...
```

Validation: parse with `datetime.fromisoformat` (after replacing `Z` → `+00:00`); if it lacks a timezone, assume UTC; reject anything that doesn't parse.

## Roll-forward

When `_api_limits` runs and an override is in the past, advance by the period (5h or 7d) until it's in the future, then persist the new value. Keeps the stored value monotonically forward and avoids the user having to re-enter after every cycle.

```python
def _roll_forward(reset_dt, now, period):
    while reset_dt <= now:
        reset_dt += period
    return reset_dt
```

## API changes

### `_api_limits` (`server/routes.py`)

```
override_5h    = preferences.get_limit_reset_at(db, "limits_five_hour_reset_at")
override_week  = preferences.get_limit_reset_at(db, "limits_weekly_reset_at")

if override_5h:
    reset = roll_forward(parse(override_5h), now, 5h)
    persist_if_changed(reset)
    used_5h     = window_billable_tokens(db, (reset - 5h).iso, pricing)
    anchor_iso  = (reset - 5h).iso
    resets_at   = reset.iso
else:  # existing auto-anchor path
    ...

if override_week:
    reset = roll_forward(parse(override_week), now, 7d)
    persist_if_changed(reset)
    since_week     = (reset - 7d).iso
    weekly_resets  = reset.iso
else:
    since_week     = (now - 7d).iso
    weekly_resets  = None  # current behavior — no anchor

used_week = window_billable_tokens(db, since_week, pricing)
weekly = _window_payload(used_week, caps.get("weekly"))
weekly["resets_at"] = weekly_resets   # NEW field; null when no override
```

The 5h response already has `anchor` and `resets_at`; the weekly response gains `resets_at`. Frontend overview/badge code that already consumes these for the 5h window can extend to weekly with no shape change.

### `/api/preferences`

- `GET` adds `limits_five_hour_reset_at`, `limits_weekly_reset_at`, `anthropic_api_key_set` (bool, never the value), `limits_last_sync_at`, `limits_last_sync_status` to the response.
- `POST` accepts the reset keys (`null` / `""` clears), and `anthropic_api_key` (string to set, `null` / `""` to clear). The key value itself is never returned in `GET`.

### `POST /api/limits/sync` (new endpoint)

Server-side sync. Reads the stored API key, makes one minimal request to Anthropic, parses headers, persists the resulting reset values + sync metadata, returns the updated state.

```python
# token_dashboard/anthropic_sync.py  (new module, stdlib only — urllib.request)

def sync_limits(api_key: str) -> dict:
    """Returns {
        'status': 'ok' | 'unsupported' | f'error:{reason}',
        'five_hour_reset_at': iso | None,
        'weekly_reset_at': iso | None,
        'raw_headers': {...},   # for debugging, not persisted
    }"""
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            resp.read()  # drain body, discard
    except urllib.error.HTTPError as e:
        # 429s still carry headers — read them
        headers = {k.lower(): v for k, v in (e.headers or {}).items()}
        if not headers:
            return {"status": f"error:http {e.code}", ...}
    except Exception as e:
        return {"status": f"error:{type(e).__name__}", ...}

    five_h_unix  = headers.get("anthropic-ratelimit-unified-5h-reset")
    week_unix    = headers.get("anthropic-ratelimit-unified-7d-reset")
    if not five_h_unix and not week_unix:
        return {"status": "unsupported", ...}
    return {
        "status": "ok",
        "five_hour_reset_at": _unix_to_iso(five_h_unix),
        "weekly_reset_at":    _unix_to_iso(week_unix),
        ...
    }
```

The route handler:
1. Loads `anthropic_api_key` from preferences. 401 to caller if absent.
2. Calls `sync_limits(key)`.
3. On `status == "ok"`: persist returned reset values via `set_limit_reset_at`; persist `limits_last_sync_at` and `limits_last_sync_status="ok"`.
4. On `unsupported` or `error:*`: persist sync meta only; reset values untouched.
5. Returns the same shape as `GET /api/preferences` plus `sync_status` so the UI can render the result.

## UI

New card in `frontend/src/routes/settings.jsx`, rendered inside the existing `Limits & alerts` `SettingsGroup`, after `BadgeCard`, only when `limitsEnabled` is true.

```
┌─ Limit reset times ─────────────────────── (saving… / hint) ─┐
│ Override the dashboard's auto-detected windows. Leave blank  │
│ to keep the auto estimate.                                   │
│                                                              │
│  Next 5h reset       [ datetime picker ]   [ Clear ]         │
│  Next weekly reset   [ datetime picker ]   [ Clear ]         │
│ ──────────────────────────────────────────────────────────── │
│ Sync from Anthropic (optional)                               │
│  API key   [ ••••••••••••••••• ]   [ Save ]   [ Forget ]     │
│  Status: Saved · key ends in …a3f2                           │
│  [ Sync now ]   Synced 2 min ago — 5h 14:32, weekly Mon 09:00│
└──────────────────────────────────────────────────────────────┘
```

Behavior:
- Field initial value: load from `/api/preferences` and convert UTC ISO → local `datetime-local` value (`YYYY-MM-DDTHH:mm`).
- On `blur` or `change`: convert back to UTC ISO with `Z`, POST `/api/preferences`. Trigger `window.RELOAD_STATIC` so Overview's "Plan limits" card refreshes.
- "Clear" sets the field to empty and POSTs `null` for that key.
- Sync section: only renders the API-key input if `anthropic_api_key_set === false`; otherwise renders the masked summary + Forget. "Sync now" disabled until a key is saved. Shows spinner while POST `/api/limits/sync` is in flight; renders status from the response.
- Disabled state: card is hidden when `limits_enabled` is false (matches BadgeCard's existing pattern).

Keep the component < 160 lines (manual + sync). No external libraries.

## Tests

All Python, stdlib `unittest`, offline.

### `tests/test_preferences.py` (extend)
- `set_limit_reset_at` with valid ISO → returns canonicalized UTC string ending in `Z`.
- `set_limit_reset_at` with `None` / `""` → clears, get returns `None`.
- `set_limit_reset_at` with garbage → returns `None`, no row written.
- `set_limit_reset_at` with invalid key → returns `None`.

### `tests/test_api_limits.py` (new or extend existing route test)
- Override in the future → window = `(reset - period, reset)`, `resets_at == override`.
- Override in the past → roll-forward advances by period; persisted value updated.
- Weekly override populates `weekly.resets_at`; no override leaves it `None`.
- 5h override fully bypasses `current_session_anchor` (test by seeding messages outside the override window — they must not count).

### `tests/test_anthropic_sync.py` (new)
Mock `urllib.request.urlopen` (stdlib `unittest.mock.patch`); no real network.
- Headers contain both unified resets → returns `status='ok'` with both ISO timestamps.
- Headers contain only the per-minute / legacy ones → returns `status='unsupported'`.
- `urlopen` raises `URLError` → returns `status='error:URLError'`.
- HTTP 429 with headers → still parses headers (treated like 200 for our purposes).
- HTTP 401 → returns `status='error:http 401'`.

### `tests/test_api_limits_sync_route.py` (new)
- POST `/api/limits/sync` with no key saved → 400 / error JSON.
- With key saved + mocked `sync_limits` returning `ok` → reset keys persisted, sync meta updated.
- With key saved + mocked `sync_limits` returning `unsupported` → reset keys untouched, sync meta updated.
- `GET /api/preferences` returns `anthropic_api_key_set: true` after Save, never the raw key.

## Files touched

| File | Change | Approx LOC |
|------|--------|-----------|
| `token_dashboard/preferences.py` | reset get/set + API-key get/set + sync meta | +60 |
| `token_dashboard/anthropic_sync.py` | **new** — single function `sync_limits(api_key)` | +90 |
| `token_dashboard/server/routes.py` | override branches in `_api_limits`; preferences GET/POST surface new keys; new `POST /api/limits/sync` route | +80 |
| `frontend/src/routes/settings.jsx` | new `LimitResetCard` (manual + sync), wired into `Limits & alerts` group | +160 |
| `tests/test_preferences.py` | reset + key + sync-meta cases | +60 |
| `tests/test_api_limits.py` | override / roll-forward cases | +40 |
| `tests/test_anthropic_sync.py` | **new** — mocked `urlopen` cases | +80 |
| `tests/test_api_limits_sync_route.py` | **new** — route-level cases | +70 |
| `CLAUDE.md` | document the user-initiated remote-call exception | +5 |

No new dependencies (uses stdlib `urllib.request`). No schema migration. No new tables.

## Security notes

- API key never logged. Server access logging in `routes.py` should redact `x-api-key`.
- `GET /api/preferences` returns `anthropic_api_key_set: bool`, never the value. Only the sync flow reads the key, never returns it.
- The dashboard binds to `127.0.0.1` by default; if the user has overridden `HOST`, the key is still only reachable to clients that can already query the dashboard (same trust boundary as everything else stored in the DB).
- Forget button issues `POST /api/preferences {anthropic_api_key: null}` and clears any cached value in memory.

## Open questions

None. Design approved (Option C — hybrid) by user 2026-05-09.
