# SSE incremental refetch (option A: hint-driven)

**Status:** Approved 2026-05-09. Implementation plan to follow.
**Scope:** Cut per-scan-tick refetch cost on the dashboard frontend by sending a "what changed" hint with each SSE scan event and refetching only the endpoints whose data depends on a touched dimension.

Option B (true row-level state deltas pushed over SSE and merged client-side) is deliberately out of scope for this iteration. See `docs/incremental-deltas-todo.md` for the option-B sketch and pros/cons.

## Problem

Today, every scan event triggers `entry.jsx`'s `RELOAD_DATA()`, which fans out **21 HTTP requests** through `Promise.all` in `frontend/src/api-client.js` (six `/api/overview` calls at different ranges plus daily, projects, tools, sessions, skills, by-model, prompts, hourly, tips, plan, limits, budget, phase-split, tags, preferences). Most scan ticks touch one or two new messages in a single project on a single day — yet we re-fetch the entire dashboard. This scales poorly for users with very large `~/.claude/projects/` trees and wastes round-trips on data that is provably static across scan ticks (plan, limits, budget, tags, preferences, tips).

## Goal

After a scan tick, refetch only the endpoints whose underlying data could have changed.

Realistic expectation:

- **Typical recent-data tick** (a few new messages on today's date in one active project / model): ~21 → ~14–16 requests. Five static endpoints (`plan`, `limits`, `budget`, `tags`, `preferences`) drop out unconditionally; everything else still updates because the data window genuinely intersects today.
- **Historical-replay tick** (scanner re-processes old days outside the active range, e.g. after a long sleep): ~21 → ~5–7 requests. Most range-scoped endpoints skip because their `since` window doesn't intersect `hint.days`.
- **No-op tick** (`messages == 0`): no event published — already true today.

The headline win is the unconditional skip of static endpoints plus the conditional skip of range-scoped endpoints when data lands outside the visible window. The bigger compounding win — pushing actual deltas instead of refetching — is option B and deferred.

## Non-goals

- Pushing row-level state deltas over SSE. (Captured in `docs/incremental-deltas-todo.md`.)
- Reducing the cold-mount fetch count. Initial load still uses the full `Promise.all`.
- Changing the wire format of any existing `/api/*` endpoint.
- Modifying the Electron tray's SSE client beyond what is needed for back-compat.

## Architecture

The server publishes a **change manifest** as part of each scan event. The client owns an **endpoint registry** that maps each endpoint to the manifest dimensions its data depends on. On every scan event, the client walks the registry and re-fetches only the entries whose declared dimensions intersect the manifest.

### Server: change manifest

`token_dashboard/scanner.scan_dir` is extended to accumulate, alongside its existing counts, the set of dimensions touched while inserting message rows for this tick:

```text
{
  "messages": int,        # existing
  "files":    int,        # existing (if currently returned)
  "sessions": [str, ...], # NEW: distinct session_ids touched
  "projects": [str, ...], # NEW: distinct project_slugs touched
  "days":     [str, ...], # NEW: distinct UTC YYYY-MM-DD of message ts
  "models":   [str, ...], # NEW: distinct model strings inserted
  "min_ts":   str | null, # NEW: earliest message ISO ts processed
  "max_ts":   str | null  # NEW: latest message ISO ts processed
}
```

Sets are accumulated during the row-insertion loop; conversion to lists happens at the return boundary so JSON serialization is straightforward and ordering is irrelevant.

`token_dashboard/server/scan_loop._scan_loop` then publishes:

```json
{
  "type": "scan",
  "n":    {"messages": <int>},
  "changed": {
    "sessions": [...],
    "projects": [...],
    "days":     [...],
    "models":   [...],
    "min_ts":   "...",
    "max_ts":   "..."
  },
  "ts": <unix_ts>
}
```

`n.messages` is preserved verbatim so any consumer relying on the current shape (notably the Electron tray badge in `electron/src/tray.js` / `electron/src/sse-client.js`) keeps working unchanged.

### Client: endpoint registry

`frontend/src/api-client.js` is restructured around a single registry. Each entry declares its `MOCK_DATA` slot, its URL builder, the post-fetch transform that produces the slot value, and one of:

| Trigger             | Meaning                                                                   | Endpoints                                                          |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `"any"`             | Refetch on any scan tick                                                  | overview (×6), tools, skills, phase-split, tips                    |
| `["sessions"]`      | Refetch only if `hint.sessions` is non-empty                              | sessions, prompts                                                  |
| `["days"]`          | Refetch only if any `hint.days` falls inside the active range window      | daily, hourly                                                      |
| `["projects"]`      | Refetch only if `hint.projects` is non-empty                              | projects                                                           |
| `["models"]`        | Refetch only if `hint.models` is non-empty                                | by-model                                                           |
| `"static"`          | Never refetched on scan tick; only on initial mount + explicit invalidate | plan, limits, budget, tags, preferences                            |

`tips` is conservatively classified `"any"` because the tips engine is data-derived and a stale tips list is more user-visible than the small cost of refetching it per tick. If profiling later shows tips is expensive, downgrade it to `["sessions"]`.

### Client: three load paths

`api-client.js` exposes three entry points instead of today's single `load()`:

1. **`loadAll(range)`** — initial mount + range switch. Walks the entire registry, full Promise.all. (Today's behavior; no perf change here.)
2. **`loadDelta(hint)`** — driven by SSE. Walks the registry, filters by `triggerMatches(entry, hint, currentRange)`, fetches the matching subset, merges results into `window.MOCK_DATA`.
3. **`loadStatic()`** — fired explicitly by settings/preferences mutations. Replaces today's call sites in `routes/settings.jsx` and `routes/sessions.jsx` that currently call `RELOAD_DATA()` after a config write.

Public surface mapping:

- `window.RELOAD_DATA` — kept; aliased to `loadAll` for back-compat with any external caller.
- `window.RELOAD_DELTA(hint)` — new; called by `entry.jsx`'s SSE handler.
- `window.RELOAD_STATIC()` — new; called by settings mutations.

### Client: SSE handler

`frontend/entry.jsx` lines 24–25 change from a blanket reload to a hint dispatch:

```js
const es = new EventSource("/api/stream");
es.onmessage = async (e) => {
  let evt;
  try { evt = JSON.parse(e.data); } catch { return; }
  if (evt.type !== "scan") return;
  if (evt.changed) {
    await window.RELOAD_DELTA(evt.changed);
  } else {
    await window.RELOAD_DATA();   // fallback for old server / missing field
  }
  render();
};
```

The fallback path matters during a rolling upgrade where the desktop app may have an older bundled server.

### Window intersection

`["days"]` is not a single window — each registry entry carries its own `windowSince(currentRange) → ISO | null`. For example:

- `overview(all-time)` → `null` (always intersects).
- `overview(today)` → today 00:00 UTC.
- `overview(7d)` → 7 days ago 00:00 UTC.
- `overview(range)` / `daily` / `projects` / `tools` / `prompts` / `by-model` / `phase-split` → the active range's `since`.
- `hourly` → 24 h ago.

Intersection rule: refetch iff `since == null` OR `max(hint.days) >= since.slice(0, 10)`. String compare on `YYYY-MM-DD` is correct because the format is lexicographically ordered.

This per-entry window is what makes the historical-replay case cheap: a tick that touches only days >30d ago intersects only `overview(all-time)` and the active range if it spans that far back; everything else skips.

## Test surface

New / extended tests:

- **`tests/test_scanner.py`** — extend with a fixture asserting `scan_dir` returns the correct `sessions / projects / days / models / min_ts / max_ts` for a synthetic two-session, two-project, two-day JSONL.
- **`tests/test_sse_delta.py`** (new, small) — given a synthetic event payload, assert the registry dispatcher selects the expected endpoint subset for representative hints (sessions-only, projects-only, days-only, mixed, empty).
- **Manual smoke** — start the server, tail the SSE stream while a fresh JSONL line is appended; verify the event carries a populated `changed` object and the frontend network tab shows < 21 requests.

Existing tests remain unchanged; the wire format of every endpoint is untouched.

## Risk register

| Risk                                                                  | Mitigation                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Hint omits a touched dimension → stale UI                              | Conservative accumulation in `scan_dir`; unit test asserts every inserted row contributes to all four sets.           |
| Old client / new server mismatch                                       | Old client ignores the new `changed` field and continues the full reload — no behavior change.                        |
| New client / old server mismatch (rolling upgrade)                     | Client falls back to `loadAll` when `evt.changed` is absent.                                                          |
| `loadDelta` partial failure leaves `MOCK_DATA` half-merged              | Each entry's transform writes into a draft object; merge into `MOCK_DATA` is a single atomic assignment after settle. |
| Static endpoints actually do change (e.g. user edits `pricing.json`)   | Existing settings-write paths call `RELOAD_STATIC()`; document this contract in `api-client.js` header comment.       |

## Out of scope (tracked elsewhere)

- Option B (push-merged state deltas): see `docs/incremental-deltas-todo.md`.
- Initial-mount snapshot push over SSE.
- Electron tray SSE refactor — keep current consumer reading `n.messages`.

## Files touched

- `token_dashboard/scanner.py` — collect change manifest sets during row insertion.
- `token_dashboard/server/scan_loop.py` — include `changed` in published event.
- `frontend/src/api-client.js` — registry, three load paths, dispatcher.
- `frontend/entry.jsx` — SSE handler dispatches hint.
- `frontend/src/routes/settings.jsx`, `frontend/src/routes/sessions.jsx` — switch settings-mutation call sites from `RELOAD_DATA` to `RELOAD_STATIC` where appropriate (call sites already enumerated in `grep` output).
- `tests/test_scanner.py` — extend.
- `tests/test_sse_delta.py` — new.
