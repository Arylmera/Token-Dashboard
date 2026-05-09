# TODO — option B: push-merged state deltas over SSE

This document captures the deferred upgrade path beyond the hint-driven selective refetch landed under `docs/superpowers/specs/2026-05-09-sse-incremental-deltas-design.md`. It is a planning artifact, not an active spec.

## When to revisit

Promote this from TODO to spec when **at least one** of the following is true:

- Scan ticks happen frequently enough that the residual selective-refetch round-trips become a UX bottleneck (perceptible UI lag on a normal-sized `~/.claude/projects/`).
- The data set grows past what full-fetch endpoints can serve cheaply (e.g. `/api/sessions` paginates or the prompts list breaks the wire-size budget).
- Real users complain about staleness during long-running sessions.

If none of those land, option A is sufficient and option B is over-engineering.

## Goal

Eliminate refetch on scan tick entirely. The SSE frame *is* the update: server pushes the actual row / aggregate deltas, client maintains a canonical store and merges in place.

## Architecture sketch

### Server

- New module `token_dashboard/server/deltas.py` that, given a scan tick's inserted rows, produces a structured delta payload. Two viable shapes:
  1. **Raw row deltas.** Server pushes the inserted message rows + any new session header rows. Client re-aggregates everything in JS for each visible range.
  2. **Per-range aggregates.** Server tracks each connected SSE client's active range (passed as a query param on `/api/stream?range=…`) and pushes pre-computed deltas matching the client's current view.
- Keep the existing `Hub` fan-out in `sse.py`. Per-client range tracking, if option-2 is chosen, lives on the subscriber object alongside the queue.
- Sequence numbers / watermarks: every published delta carries an integer `seq`. Clients send `Last-Event-ID: <seq>` on reconnect; server replays a small ring buffer or signals "too far behind, do a full reload".
- Snapshot endpoint: `/api/snapshot?range=…` becomes the canonical cold-load (collapses today's 21 calls into one). Returns the same normalized shape the deltas merge into.

### Client

- Replace `window.MOCK_DATA` with a normalized store: `{ sessions: ById, prompts: ById, dailyByDay: ByKey, projectsBySlug: ByKey, modelsByName: ByKey, … }`.
- Selectors (`getOverviewForRange`, `getDailyForRange`, etc.) compute view-time aggregates from the store. The route components consume selector output in the shape they consume `MOCK_DATA` today.
- Merge functions per slice: `mergeMessages(delta)`, `mergeSessions(delta)`, etc. Pure, unit-testable.
- SSE handler dispatches by `evt.kind` to the right merger. UI re-renders without a network round-trip.

## Pros

- Zero refetch on scan tick.
- Lower disk-write → pixel latency.
- Scales as O(changed rows), not O(table size).
- Opens the door to optimistic UI and partial reconnect resume via `Last-Event-ID`.
- A single canonical snapshot endpoint also shrinks cold-load (collapses `Promise.all` of 21 into 1).

## Cons

- Frontend rewrite: `api-client.js` and every tab that reads `MOCK_DATA` need to switch to selectors.
- Aggregate parity: if server pushes raw rows, JS must re-implement the SQL aggregations (`/api/overview`, `/api/daily`, `/api/by-model`, etc.) — easy to drift from the Python truth. If server pushes per-range aggregates, the server becomes stateful per connection.
- Schema becomes a contract. Today each endpoint is small and isolated; a delta protocol couples them.
- More failure modes (merge bugs, ordering bugs, dropped events under backpressure — `sse.py` already drops oldest under `queue.Full`).
- More test surface. Need golden tests for delta-merge parity vs full-fetch.
- Range switches still need a snapshot fetch — option B doesn't eliminate that path, it adds a parallel one.

## Implementation outline (when promoted)

1. **Snapshot endpoint.** Land `/api/snapshot?range=…` first; switch cold-load to use it. Pure win, independent of deltas.
2. **Normalized store + selectors on the client.** Migrate tab-by-tab from `MOCK_DATA` to selector-backed reads. Keep both paths alive during migration.
3. **Delta protocol.** Choose raw-rows vs per-range. If unsure, prototype both for a single slice (sessions) and measure code complexity + correctness.
4. **Per-slice mergers + tests.** One slice at a time: messages, sessions, prompts, daily, projects, models, tools, skills.
5. **Watermarks + reconnect.** Add `seq` and `Last-Event-ID` handling once mergers are stable.
6. **Drop selective-refetch path** for slices that have a working merger. Keep it as fallback for slices that don't.
7. **Remove `loadAll` once snapshot + deltas cover every slice.**

## Open questions to resolve before promoting

- **Per-client server state, yes or no?** Decides raw-rows vs per-range. Affects how Electron tray clients are treated (they don't render aggregates, so they could just take raw events and ignore them).
- **Where do derived numbers like cost per prompt live?** Today `pricing.json` is read server-side. Either bake cost into the delta payload, or push pricing once and compute client-side.
- **Tips engine.** Today rule-based, runs on demand. Does it stay polled, or does it move to a push model? (Probably stays polled — it's not row-driven.)
- **Range awareness in tray client.** The Electron tray currently consumes `n.messages` only. If the wire format gains structure, formalize what the tray needs vs what the dashboard needs and consider separate event types.

## What option A leaves on the floor (justification for keeping this TODO)

- Network round-trips per tick are not zero — typical case is 3–5 instead of 21.
- Initial mount still does the full Promise.all.
- Aggregate endpoints are still recomputed from scratch on the server even when the underlying data didn't change in a way that affects the active range.

These are real, just not yet painful. Option B is the right answer if and when they become painful.
