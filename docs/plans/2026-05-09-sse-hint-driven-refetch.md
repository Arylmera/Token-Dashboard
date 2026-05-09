# SSE hint-driven selective refetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-scan-tick refetch cost on the dashboard by sending a "what changed" manifest with each SSE scan event so the client refetches only endpoints whose data depends on a touched dimension.

**Architecture:** The Python scanner accumulates touched `sessions / projects / days / models / min_ts / max_ts` while inserting rows. The scan loop publishes those alongside the existing event. The React client owns an endpoint registry that maps each `MOCK_DATA` slot to the dimensions its data depends on, plus a per-entry `windowSince(currentRange)` for range-scoped endpoints. On every scan event the client walks the registry and refetches only the matching subset; static endpoints leave the scan-tick path entirely.

**Tech Stack:** Python 3 (stdlib only — no `pip install`), SQLite, React 18 + esbuild bundle, EventSource SSE.

**Spec:** `docs/specs/2026-05-09-sse-incremental-deltas-design.md`. Option B (push-merged state deltas) is deferred — see `docs/incremental-deltas-todo.md`.

**Verification commands:**
- Python tests: `python3 -m unittest discover tests`
- Frontend bundle: `cd frontend && npm run build`
- End-to-end smoke: `python3 cli.py dashboard --no-open` then `curl http://127.0.0.1:8080/api/overview`

---

## File map

| Path | Status | Responsibility |
| --- | --- | --- |
| `token_dashboard/scanner.py` | modify | Accumulate change manifest in `scan_file` and aggregate it in `scan_dir`. |
| `token_dashboard/server/scan_loop.py` | modify | Forward the manifest into the published `scan` event under `changed`. |
| `frontend/src/api-client.js` | modify | Replace single `load()` with registry + `loadAll` / `loadDelta` / `loadStatic`. |
| `frontend/src/sse-dispatch.js` | create | Pure dispatcher: `pickEntries(registry, hint, currentRange) → string[]`. |
| `frontend/entry.jsx` | modify | SSE handler routes `evt.changed` through `RELOAD_DELTA`, falls back to `RELOAD_DATA` when absent. |
| `frontend/src/routes/settings.jsx` | modify | Switch settings-mutation refresh sites from `RELOAD_DATA` to `RELOAD_STATIC`. |
| `frontend/src/routes/sessions.jsx` | modify | Same — settings-style mutation site at `:301`. |
| `tests/test_scanner_manifest.py` | create | Assert `scan_dir` returns the manifest dimensions for fixture JSONLs. |
| `tests/test_sse_dispatch.py` | create | Assert `pickEntries` selects the right subset for representative hints (Python port test for the JS function — see Task 5). |

---

## Task 1: Scanner — accumulate change manifest in `scan_file`

**Files:**
- Modify: `token_dashboard/scanner.py:189-244` (the `scan_file` function)
- Test: `tests/test_scanner_manifest.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_scanner_manifest.py`:

```python
"""Verifies scan_dir returns the change manifest used by SSE hints."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from token_dashboard.db import init_db
from token_dashboard.scanner import scan_dir


def _line(rec: dict) -> str:
    return json.dumps(rec) + "\n"


class ScanManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.projects = self.root / "projects"
        (self.projects / "proj-a").mkdir(parents=True)
        (self.projects / "proj-b").mkdir(parents=True)
        self.db = str(self.root / "test.db")
        init_db(self.db)

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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tests.test_scanner_manifest -v`
Expected: FAIL with `KeyError: 'sessions'` or similar on the first manifest assertion.

- [ ] **Step 3: Implement manifest accumulation in `scan_file`**

Edit `token_dashboard/scanner.py`. In `scan_file` (around line 197), initialize manifest sets and accumulate per-row:

Replace lines 197-198:

```python
    msgs = tools = 0
    end_offset = start_byte
```

with:

```python
    msgs = tools = 0
    end_offset = start_byte
    seen_sessions: set[str] = set()
    seen_models: set[str] = set()
    seen_days: set[str] = set()
    min_ts: str | None = None
    max_ts: str | None = None
```

Then, immediately after `msgs += 1` (around line 242, after the tool insert loop), add:

```python
            seen_sessions.add(msg["session_id"])
            if msg["model"]:
                seen_models.add(msg["model"])
            ts = msg["timestamp"]
            if ts:
                seen_days.add(ts[:10])
                if min_ts is None or ts < min_ts:
                    min_ts = ts
                if max_ts is None or ts > max_ts:
                    max_ts = ts
```

Update the return dict at line 244:

```python
    return {
        "messages": msgs,
        "tools":    tools,
        "end_offset": end_offset,
        "sessions": sorted(seen_sessions),
        "models":   sorted(seen_models),
        "days":     sorted(seen_days),
        "min_ts":   min_ts,
        "max_ts":   max_ts,
    }
```

- [ ] **Step 4: Aggregate manifest across files in `scan_dir`**

In `scan_dir` (lines 247-279), extend `totals` initialization (line 249):

```python
    totals = {
        "messages": 0, "tools": 0, "files": 0,
        "sessions": set(), "projects": set(),
        "days": set(), "models": set(),
        "min_ts": None, "max_ts": None,
    }
```

After the existing `totals["files"] += 1` (line 277), add:

```python
            if sub["sessions"]:
                totals["sessions"].update(sub["sessions"])
                totals["projects"].add(slug)
                totals["days"].update(sub["days"])
                totals["models"].update(sub["models"])
                if sub["min_ts"] and (totals["min_ts"] is None or sub["min_ts"] < totals["min_ts"]):
                    totals["min_ts"] = sub["min_ts"]
                if sub["max_ts"] and (totals["max_ts"] is None or sub["max_ts"] > totals["max_ts"]):
                    totals["max_ts"] = sub["max_ts"]
```

Then convert the sets to sorted lists right before returning. Replace `return totals` (line 279) and the early-return at line 251:

```python
    if not root.is_dir():
        return _finalize(totals)
    ...
    return _finalize(totals)
```

Add a private helper above `scan_dir`:

```python
def _finalize(totals: dict) -> dict:
    return {
        "messages": totals["messages"],
        "tools":    totals["tools"],
        "files":    totals["files"],
        "sessions": sorted(totals["sessions"]) if isinstance(totals["sessions"], set) else totals["sessions"],
        "projects": sorted(totals["projects"]) if isinstance(totals["projects"], set) else totals["projects"],
        "days":     sorted(totals["days"])     if isinstance(totals["days"], set)     else totals["days"],
        "models":   sorted(totals["models"])   if isinstance(totals["models"], set)   else totals["models"],
        "min_ts":   totals["min_ts"],
        "max_ts":   totals["max_ts"],
    }
```

- [ ] **Step 5: Run the manifest tests to verify they pass**

Run: `python3 -m unittest tests.test_scanner_manifest -v`
Expected: PASS for both test cases.

- [ ] **Step 6: Run the full test suite to verify no regressions**

Run: `python3 -m unittest discover tests`
Expected: PASS — no existing tests should break (the `messages / tools / files` keys are unchanged; new keys are additive).

- [ ] **Step 7: Commit**

```bash
git add token_dashboard/scanner.py tests/test_scanner_manifest.py
git commit -m "scanner: emit change manifest (sessions, projects, days, models, ts bounds)"
```

---

## Task 2: scan_loop — publish manifest in `scan` event

**Files:**
- Modify: `token_dashboard/server/scan_loop.py:33-41` (the `_scan_loop` function)
- Test: extend `tests/test_scanner_manifest.py` if there is no existing scan_loop test (skip — covered manually below)

- [ ] **Step 1: Modify `_scan_loop` to forward the manifest**

In `token_dashboard/server/scan_loop.py`, replace the body of `_scan_loop` (lines 33-41):

```python
def _scan_loop(db_path: str, projects_dir: str, interval: float = DEFAULT_SCAN_INTERVAL):
    while True:
        try:
            n = scan_dir(projects_dir, db_path)
            if n["messages"] > 0:
                EVENTS.publish({
                    "type": "scan",
                    "n": {"messages": n["messages"]},  # back-compat for tray client
                    "changed": {
                        "sessions": n.get("sessions") or [],
                        "projects": n.get("projects") or [],
                        "days":     n.get("days") or [],
                        "models":   n.get("models") or [],
                        "min_ts":   n.get("min_ts"),
                        "max_ts":   n.get("max_ts"),
                    },
                    "ts": time.time(),
                })
        except Exception as e:
            EVENTS.publish({"type": "error", "message": str(e)})
        time.sleep(interval)
```

- [ ] **Step 2: Manual end-to-end check**

Run, in two terminals:

```bash
# Terminal 1
python3 cli.py dashboard --no-open
```

```bash
# Terminal 2
curl -N http://127.0.0.1:8080/api/stream
```

Trigger a scan by appending a single record to a JSONL under `~/.claude/projects/`. Within ~5 s, the SSE stream should emit a frame whose JSON payload includes a `changed` object with non-empty `sessions / projects / days / models`.

If you cannot trigger a real scan, this manual step is optional — the unit test in Task 1 already exercises the manifest math, and Task 5 tests the dispatcher.

- [ ] **Step 3: Commit**

```bash
git add token_dashboard/server/scan_loop.py
git commit -m "scan_loop: include change manifest in scan events"
```

---

## Task 3: Frontend — endpoint registry + `loadAll`

**Files:**
- Modify: `frontend/src/api-client.js` (full restructure of `fetchAll` + `load`)

- [ ] **Step 1: Replace the flat `fetchAll` with a registry**

Open `frontend/src/api-client.js`. Replace the `fetchAll` function (lines 76-106) and `load` (lines 265-301) with the following structure. Keep all helpers (`fmtTime`, `relTime`, `shortModel`, `shortDate`, `j`, `isoDaysAgo`, `RANGE_DAYS`, `RANGE_LABELS`, `billable`, `totalTokens`, all the `build*` helpers, `WEEKDAYS`, `WEEK_MS`, `EMPTY_DATA`) unchanged.

After the helper block (right after `let currentRange = "30d";`), insert:

```js
// Endpoint registry. Each entry declares:
//   key       — slot in MOCK_DATA the result lands in
//   url(ctx)  — URL builder, given { rangeSince, range }
//   trigger   — "any" | "static" | "sessions" | "projects" | "models" | "days"
//   windowSince(range) — only for ["days"]; returns ISO since-bound or null
//   reduce    — final-shape transform, called with (raw, accum, ctx)
//
// loadAll runs every entry. loadDelta runs entries whose trigger matches the
// hint (with windowSince intersection for "days"). loadStatic runs only
// entries where trigger === "static".
const REG = [
  { key: "overviewAll",   trigger: "any",   url: () => "/api/overview" },
  { key: "overview30",    trigger: "days",  windowSince: () => isoDaysAgo(30), url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(30))}` },
  { key: "overview7",     trigger: "days",  windowSince: () => isoDaysAgo(7),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(7))}` },
  { key: "overviewToday", trigger: "days",  windowSince: () => isoDaysAgo(0),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(0))}` },
  { key: "overviewYday",  trigger: "days",  windowSince: () => isoDaysAgo(1),  url: () => `/api/overview?since=${encodeURIComponent(isoDaysAgo(1))}&until=${encodeURIComponent(isoDaysAgo(0))}` },
  { key: "overviewRange", trigger: "days",  windowSince: (r) => r, url: ({ rangeSince }) => `/api/overview${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "daily",         trigger: "days",  windowSince: (r) => r, url: ({ rangeSince }) => `/api/daily${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "projects",      trigger: "projects", url: ({ rangeSince }) => `/api/projects${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "tools",         trigger: "any",   url: ({ rangeSince }) => `/api/tools${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "sessionsRaw",   trigger: "sessions", url: ({ rangeSince }) => `/api/sessions?${rangeSince ? `since=${encodeURIComponent(rangeSince)}&` : ""}limit=50` },
  { key: "skills",        trigger: "any",   url: ({ rangeSince }) => `/api/skills${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "byModel",       trigger: "models", url: ({ rangeSince }) => `/api/by-model${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}` },
  { key: "prompts",       trigger: "sessions", url: ({ rangeSince }) => `/api/prompts?${rangeSince ? `since=${encodeURIComponent(rangeSince)}&` : ""}limit=20&sort=tokens` },
  { key: "hourlyRaw",     trigger: "days",  windowSince: () => isoDaysAgo(1), url: () => "/api/hourly?hours=24", fallback: () => [] },
  { key: "tips",          trigger: "any",   url: () => "/api/tips", fallback: () => [] },
  { key: "planResp",      trigger: "static", url: () => "/api/plan",   fallback: () => ({ plan: "max" }) },
  { key: "limitsResp",    trigger: "static", url: () => "/api/limits", fallback: () => null },
  { key: "budgetResp",    trigger: "static", url: () => "/api/budget", fallback: () => null },
  { key: "phaseResp",     trigger: "any",   url: ({ rangeSince }) => `/api/phase-split${rangeSince ? `?since=${encodeURIComponent(rangeSince)}` : ""}`, fallback: () => null },
  { key: "tagsResp",      trigger: "static", url: () => "/api/tags", fallback: () => [] },
  { key: "prefsResp",     trigger: "static", url: () => "/api/preferences", fallback: () => null },
];

const _cache = {};   // last-known raw value per key
```

- [ ] **Step 2: Add `_fetchKeys(keys, ctx)` and rewrite `load` as `loadAll`**

After the registry, add:

```js
async function _fetchKeys(keys, ctx) {
  const tasks = keys.map(async (k) => {
    const entry = REG.find((e) => e.key === k);
    try {
      const v = await j(entry.url(ctx));
      _cache[k] = v;
    } catch (err) {
      if (entry.fallback) _cache[k] = entry.fallback();
      else throw err;
    }
  });
  await Promise.all(tasks);
}

function _ctx(range) {
  const days = RANGE_DAYS[range];
  return { range, rangeSince: days == null ? null : isoDaysAgo(days) };
}

function _rebuildMockData(range) {
  const c = _cache;
  const totals = buildTotals(range, c.overviewAll || {}, c.overview30 || {}, c.overview7 || {}, c.overviewToday || {}, c.overviewYday || {}, c.overviewRange || {});
  const hourly = buildHourly(c.hourlyRaw || []);
  window.MOCK_DATA = {
    totals,
    daily:    buildDaily(c.daily || [], totals.range),
    projects: buildProjects(c.projects || [], totals.range),
    models:   buildModels(c.byModel || []),
    tools:    (c.tools || []).map((t) => ({ name: t.tool_name, calls: t.calls || 0, tokens: t.result_tokens || 0 })),
    sessions: buildSessions(c.sessionsRaw || []),
    prompts:  buildPrompts(c.prompts || []),
    skills:   buildSkills(c.skills || []),
    tips:     buildTips(c.tips || []),
    hourly,
    heatmap:  buildHeatmap(c.sessionsRaw || []),
    burn:     buildBurn(hourly, totals.week),
    plan:     c.planResp || { plan: "max" },
    limits:   c.limitsResp || null,
    budget:   c.budgetResp || null,
    phase:    c.phaseResp || null,
    tags:     Array.isArray(c.tagsResp) ? c.tagsResp : [],
    prefs:    c.prefsResp || null,
  };
}

async function loadAll(range) {
  if (range !== undefined && RANGE_DAYS[range] !== undefined) currentRange = range;
  const r = currentRange;
  await _fetchKeys(REG.map((e) => e.key), _ctx(r));
  _rebuildMockData(r);
}
```

- [ ] **Step 3: Replace the public side-effect block at the bottom**

Replace the final block (lines 303-308):

```js
window.DATA_READY = loadAll().catch((err) => {
  console.error("data load failed", err);
  window.MOCK_DATA = window.MOCK_DATA || EMPTY_DATA();
});

window.RELOAD_DATA = loadAll;            // back-compat alias
```

(`RELOAD_DELTA` and `RELOAD_STATIC` are added in Tasks 5/6.)

- [ ] **Step 4: Build the bundle and verify it loads**

```bash
cd frontend && npm run build
```

Expected: builds to `dist/app.js` with no errors. Open `http://127.0.0.1:8080/` in a browser and confirm the dashboard renders with real data — this proves `loadAll` matches the prior `load` behavior.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api-client.js frontend/dist/app.js
git commit -m "frontend: refactor api-client into endpoint registry + loadAll"
```

---

## Task 4: Frontend — pure dispatcher module

**Files:**
- Create: `frontend/src/sse-dispatch.js`
- Test: defer to Task 5 (manual integration)

- [ ] **Step 1: Create the dispatcher**

```js
// frontend/src/sse-dispatch.js
// Pure function: given the registry, an SSE hint, and the active range's
// since-ISO, return the list of registry keys to refetch.
//
// Hint shape: { sessions, projects, days, models, min_ts, max_ts } (all optional).
// Range since-ISO is the active currentRange's "since" boundary, or null for "all".

export function pickEntries(registry, hint, rangeSince) {
  const out = [];
  const h = hint || {};
  const has = {
    sessions: Array.isArray(h.sessions) && h.sessions.length > 0,
    projects: Array.isArray(h.projects) && h.projects.length > 0,
    models:   Array.isArray(h.models)   && h.models.length   > 0,
    daysMax:  Array.isArray(h.days) && h.days.length > 0
      ? h.days.reduce((a, b) => (a > b ? a : b))
      : null,
  };
  for (const e of registry) {
    if (e.trigger === "static") continue;
    if (e.trigger === "any") { out.push(e.key); continue; }
    if (e.trigger === "sessions" && has.sessions) { out.push(e.key); continue; }
    if (e.trigger === "projects" && has.projects) { out.push(e.key); continue; }
    if (e.trigger === "models"   && has.models)   { out.push(e.key); continue; }
    if (e.trigger === "days") {
      if (!has.daysMax) continue;
      const since = e.windowSince ? e.windowSince(rangeSince) : rangeSince;
      if (since == null) { out.push(e.key); continue; }   // unbounded window
      if (has.daysMax >= since.slice(0, 10)) { out.push(e.key); continue; }
    }
  }
  return out;
}

export function pickStaticEntries(registry) {
  return registry.filter((e) => e.trigger === "static").map((e) => e.key);
}
```

- [ ] **Step 2: Commit (no test yet — Task 5 wires it in and verifies)**

```bash
git add frontend/src/sse-dispatch.js
git commit -m "frontend: pure SSE hint dispatcher (pickEntries / pickStaticEntries)"
```

---

## Task 5: Frontend — `loadDelta`, `loadStatic`, dispatcher test

**Files:**
- Modify: `frontend/src/api-client.js` (top of file: import dispatcher; bottom: expose new globals)
- Create: `frontend/src/sse-dispatch.test.html` (manual self-checking page — see Step 3)

- [ ] **Step 1: Wire dispatcher into `api-client.js`**

At the top of `frontend/src/api-client.js`, add the import (right under the leading comment block):

```js
import { pickEntries, pickStaticEntries } from "./sse-dispatch.js";
```

After the `loadAll` definition, add:

```js
async function loadDelta(hint) {
  const r = currentRange;
  const ctx = _ctx(r);
  const keys = pickEntries(REG, hint || {}, ctx.rangeSince);
  if (keys.length === 0) return;          // nothing in our view changed
  await _fetchKeys(keys, ctx);
  _rebuildMockData(r);
}

async function loadStatic() {
  const r = currentRange;
  const ctx = _ctx(r);
  await _fetchKeys(pickStaticEntries(REG), ctx);
  _rebuildMockData(r);
}
```

Replace the public side-effect block again to expose the new globals:

```js
window.DATA_READY = loadAll().catch((err) => {
  console.error("data load failed", err);
  window.MOCK_DATA = window.MOCK_DATA || EMPTY_DATA();
});

window.RELOAD_DATA   = loadAll;     // back-compat alias
window.RELOAD_DELTA  = loadDelta;
window.RELOAD_STATIC = loadStatic;
```

- [ ] **Step 2: Build the bundle and confirm it still works**

```bash
cd frontend && npm run build
```

Expected: clean build. Reload the dashboard in a browser; behavior should be identical because `RELOAD_DATA` still points at `loadAll` and the SSE handler hasn't been switched yet (Task 6).

- [ ] **Step 3: Quick dispatcher sanity check**

Create `frontend/src/sse-dispatch.test.html` (do **not** add to the bundle — open directly in a browser as a one-shot smoke test):

```html
<!doctype html><meta charset="utf-8"><title>dispatch smoke</title>
<pre id="out"></pre>
<script type="module">
import { pickEntries, pickStaticEntries } from "./sse-dispatch.js";
const REG = [
  { key: "any1",      trigger: "any" },
  { key: "static1",   trigger: "static" },
  { key: "sessions1", trigger: "sessions" },
  { key: "projects1", trigger: "projects" },
  { key: "models1",   trigger: "models" },
  { key: "daysFixed", trigger: "days", windowSince: () => "2026-05-01T00:00:00Z" },
  { key: "daysRange", trigger: "days", windowSince: (r) => r },
];
const cases = [
  ["empty hint",                  {},                              null,                    ["any1"]],
  ["sessions only",               { sessions: ["s1"] },            null,                    ["any1", "sessions1"]],
  ["days touch fixed window",     { days: ["2026-05-09"] },        null,                    ["any1", "daysFixed", "daysRange"]],
  ["days outside fixed window",   { days: ["2026-04-01"] },        "2026-05-01T00:00:00Z",  ["any1"]],
  ["days inside range bound",     { days: ["2026-05-09"] },        "2026-05-08T00:00:00Z",  ["any1", "daysFixed", "daysRange"]],
];
const log = [];
for (const [name, hint, range, expect] of cases) {
  const got = pickEntries(REG, hint, range);
  const ok = JSON.stringify(got.sort()) === JSON.stringify(expect.slice().sort());
  log.push((ok ? "PASS" : "FAIL") + " — " + name + "\n  got: " + JSON.stringify(got) + "\n  exp: " + JSON.stringify(expect));
}
log.push("static: " + JSON.stringify(pickStaticEntries(REG)));
document.getElementById("out").textContent = log.join("\n");
</script>
```

Open the file via `http://127.0.0.1:8080/web/src/sse-dispatch.test.html` (or directly via `file://`). All five cases should print `PASS`. Delete the file after verification — it's not part of the production bundle.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api-client.js frontend/dist/app.js
git commit -m "frontend: add loadDelta + loadStatic, wire dispatcher"
```

---

## Task 6: SSE handler dispatches hint

**Files:**
- Modify: `frontend/entry.jsx:24-25`

- [ ] **Step 1: Replace the SSE handler**

Open `frontend/entry.jsx`. Find the `EventSource` setup (around line 24). Replace:

```js
const es = new EventSource("/api/stream");
es.onmessage = async () => { await window.RELOAD_DATA(); render(); };
```

with:

```js
const es = new EventSource("/api/stream");
es.onmessage = async (e) => {
  let evt = null;
  try { evt = JSON.parse(e.data); } catch { return; }
  if (!evt || evt.type !== "scan") return;
  if (evt.changed && window.RELOAD_DELTA) {
    await window.RELOAD_DELTA(evt.changed);
  } else {
    await window.RELOAD_DATA();   // fallback for old server / missing changed
  }
  render();
};
```

- [ ] **Step 2: Build and verify behavior**

```bash
cd frontend && npm run build
```

Then start the server (`python3 cli.py dashboard --no-open`) and open the dashboard. Open browser devtools → Network → filter by `Fetch`. Trigger a scan (append a record to a JSONL under `~/.claude/projects/`). Within ~5 s you should see fewer than 21 fetches — typically 8–12 (the static endpoints `plan`, `limits`, `budget`, `tags`, `preferences` should be absent).

- [ ] **Step 3: Commit**

```bash
git add frontend/entry.jsx frontend/dist/app.js
git commit -m "frontend: route SSE scan events through hint dispatcher"
```

---

## Task 7: Settings/sessions mutation sites use `RELOAD_STATIC`

**Files:**
- Modify: `frontend/src/routes/settings.jsx:346, 407, 508, 523, 537, 821`
- Modify: `frontend/src/routes/sessions.jsx:301`

Settings mutations that change `tags`, `prefs`, `plan`, `limits`, or `budget` only need the static slots refreshed. Switching them off `RELOAD_DATA` removes the spurious 21-endpoint refetch.

- [ ] **Step 1: Inspect each call site**

Read each line above and identify what was just mutated:
- `settings.jsx:346` — typically a tag CRUD operation → `RELOAD_STATIC`.
- `settings.jsx:407` — typically a preferences write → `RELOAD_STATIC`.
- `settings.jsx:508`, `:523`, `:537` — typically plan / limits / budget writes → `RELOAD_STATIC`.
- `settings.jsx:821` — read context to decide. If it follows a setting mutation, `RELOAD_STATIC`. If it follows a data-affecting action (e.g. a rescan trigger), keep `RELOAD_DATA`.
- `sessions.jsx:301` — this follows a session-tag write. Since `tags` is `static` but the tag list is part of session display, prefer `RELOAD_DATA` here unless the tag write is reflected purely through `/api/tags` and `/api/sessions` (which is `["sessions"]` — would need a hint). Keep as `RELOAD_DATA` for safety; this is a rare user-driven event, not a hot path.

- [ ] **Step 2: Apply the safe substitutions**

Read `frontend/src/routes/settings.jsx` to confirm each line's context. For lines where the mutation is purely a write to a static endpoint (no scanner-side state change), replace:

```js
if (window.RELOAD_DATA) window.RELOAD_DATA();
```

with:

```js
if (window.RELOAD_STATIC) window.RELOAD_STATIC();
```

When uncertain, leave the call as `RELOAD_DATA` — correctness over micro-optimization.

- [ ] **Step 3: Build and smoke-test**

```bash
cd frontend && npm run build
```

Open the dashboard, change a preference / add a tag / edit a budget. Verify:
1. The setting persists (reload still shows the change).
2. The Network panel shows only the static endpoints fetched after the mutation, not all 21.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/settings.jsx frontend/src/routes/sessions.jsx frontend/dist/app.js
git commit -m "frontend: use RELOAD_STATIC for settings-only mutation refreshes"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full Python test suite**

Run: `python3 -m unittest discover tests`
Expected: all 68+ existing tests pass + the two new manifest tests added in Task 1.

- [ ] **Step 2: Frontend bundle clean build**

Run: `cd frontend && npm run build`
Expected: builds without warnings or errors.

- [ ] **Step 3: Manual end-to-end smoke**

1. `python3 cli.py dashboard --no-open`
2. Open `http://127.0.0.1:8080/`
3. Open browser devtools Network panel, filter `Fetch`.
4. Append a JSONL record to a real session under `~/.claude/projects/<slug>/<session>.jsonl` (or wait for Claude Code to do it naturally).
5. Within one scan interval (~5 s) the dashboard should refresh.

Expected:
- Cold load: ~21 fetches (unchanged).
- Recent-data scan tick: 8–14 fetches; the five static endpoints (`/api/plan`, `/api/limits`, `/api/budget`, `/api/tags`, `/api/preferences`) are absent.
- Historical-replay tick (rare — only after a long sleep): 5–7 fetches.

- [ ] **Step 4: Sanity-check the SSE payload**

Run: `curl -N http://127.0.0.1:8080/api/stream` in a separate terminal during a scan. Confirm the event payload contains a populated `changed` object with the four list dimensions and `min_ts`/`max_ts` strings.

- [ ] **Step 5: Final commit if any verification fixes were needed**

If the verification in Steps 3–4 surfaced regressions, fix them and commit. Otherwise no further commit is needed — the per-task commits already capture the work.

---

## What the plan deliberately does NOT do

- **No row-level state push.** That's option B (`docs/incremental-deltas-todo.md`).
- **No initial-mount payload reduction.** Cold mount still uses the full Promise.all via `loadAll`.
- **No Electron tray refactor.** The tray reads `n.messages` from the event; that field is preserved.
- **No backend wire-format changes** to any `/api/*` endpoint. Only the SSE event gains a new optional `changed` field.
