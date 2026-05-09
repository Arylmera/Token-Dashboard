# User-set 5h and weekly limit reset times

**Date:** 2026-05-09
**Status:** Design approved, awaiting plan
**Scope:** Settings UI + backend preferences + `/api/limits` override

## Problem

The dashboard currently estimates Anthropic's rate-limit windows:

- **5h window** is auto-anchored at the first assistant message of the active session (`current_session_anchor` in `db/queries.py`). Resets 5 hours later.
- **Weekly window** is a rolling `now - 7d` slice with no real anchor.

Both estimates can drift from Anthropic's actual reset times, which depend on each user's account-level usage history (including traffic from claude.ai or other clients the dashboard doesn't read). Users who watch their real reset times in claude.ai have no way to align the dashboard.

## Goal

Let users override the next reset datetime for each window from Settings. When set, the dashboard treats `(reset - period, reset)` as the active window and uses that for "Plan limits remaining" cards, status indicator (badge), and any other limit-driven UI. Blank = current auto-detection behavior.

## Non-goals

- Detecting reset times from Anthropic's API (no public quota endpoint).
- Per-plan or per-account multi-window tracking.
- Notification when a reset is imminent.

## User-facing model

- One datetime field per window: "Next 5h reset", "Next weekly reset".
- Native browser datetime picker (`<input type="datetime-local">`) — no free-form text, no parse errors at the boundary.
- Blank field = auto-detect (today's behavior). A "Clear" affordance per field.
- The picker reads/writes local time; the server stores UTC.
- Card lives in the existing "Limits & alerts" settings group, visible only when `limits_enabled` is on.

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

Two new keys in the existing `plan` k/v table (no schema migration needed):

| Key                            | Format                  | Default |
|--------------------------------|-------------------------|---------|
| `limits_five_hour_reset_at`    | ISO 8601 UTC, `…Z`      | absent  |
| `limits_weekly_reset_at`       | ISO 8601 UTC, `…Z`      | absent  |

Absent / empty string = use auto-detection.

### `preferences.py` additions (~30 LOC)

```python
LIMIT_RESET_KEYS = ("limits_five_hour_reset_at", "limits_weekly_reset_at")

def get_limit_reset_at(db_path, key) -> "str | None":
    # validate key in LIMIT_RESET_KEYS, return ISO string or None

def set_limit_reset_at(db_path, key, iso_or_none) -> "str | None":
    # accept None / "" to clear; reject unparseable; store as UTC ISO with Z suffix
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

- `GET` adds `limits_five_hour_reset_at` and `limits_weekly_reset_at` to the response (string or null).
- `POST` accepts the same keys; `null` or `""` clears.

## UI

New card in `frontend/src/routes/settings.jsx`, rendered inside the existing `Limits & alerts` `SettingsGroup`, after `BadgeCard`, only when `limitsEnabled` is true.

```
┌─ Limit reset times ─────────────────────── (saving… / hint) ─┐
│ Override the dashboard's auto-detected windows when you      │
│ know your real reset time from claude.ai. Leave blank to     │
│ keep the auto estimate.                                      │
│                                                              │
│  Next 5h reset       [ datetime picker ]   [ Clear ]         │
│  Next weekly reset   [ datetime picker ]   [ Clear ]         │
└──────────────────────────────────────────────────────────────┘
```

Behavior:
- Field initial value: load from `/api/preferences` and convert UTC ISO → local `datetime-local` value (`YYYY-MM-DDTHH:mm`).
- On `blur` or `change`: convert back to UTC ISO with `Z`, POST `/api/preferences`. Trigger `window.RELOAD_STATIC` so Overview's "Plan limits" card refreshes.
- "Clear" sets the field to empty and POSTs `null` for that key.
- Disabled state: card is hidden when `limits_enabled` is false (matches BadgeCard's existing pattern).

Keep the component < 100 lines. No external libraries. Native picker is sufficient and matches the project's stdlib-only ethos.

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

## Files touched

| File | Change | Approx LOC |
|------|--------|-----------|
| `token_dashboard/preferences.py` | +`LIMIT_RESET_KEYS`, get/set helpers | +30 |
| `token_dashboard/server/routes.py` | override branches in `_api_limits`; preferences GET/POST surface new keys | +35 |
| `frontend/src/routes/settings.jsx` | new `LimitResetCard`, wired into `Limits & alerts` group | +80 |
| `tests/test_preferences.py` | new cases | +30 |
| `tests/test_api_limits.py` | new cases (or extend existing route tests) | +40 |

No new dependencies. No schema migration. No new tables.

## Open questions

None. Design approved by user 2026-05-09.
