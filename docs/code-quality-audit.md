# Code Quality Audit — Token Dashboard v4.1.1

Date: 2026-05-21
Scope: full stack (Rust workspace, frontend, build/CI/docs).
Status: audit only — no edits applied yet.

## Headline

The codebase is in good shape overall: clippy clean, no SQL injection vectors, no committed secrets, tight CI matrix, sensible deps. The pain points are concentrated:

1. **`crates/token-dashboard-cli/src/lib.rs` is a 2,960-line god object** — routes, handlers, serialization, cache, and CSV/JSON export all crammed into one file. This is the single biggest quality drag.
2. **`crates/token-dashboard-tauri/src/main.rs` (894 lines)** mixes app init, signal handling, port selection, and IPC.
3. **Frontend uses `window.MOCK_DATA` as a global data bus** with mutable module-level state in `api-client.js`. Combined with prop drilling and zero type safety, refactors are risky.
4. **`tauri.conf.json` sets `"csp": null`** — the webview has no Content Security Policy. Since the frontend is fully local, a tight CSP is achievable.

Everything else is medium/low.

---

## Findings by severity

### Critical

| # | Area | Finding |
|---|------|---------|
| C1 | Rust / cli | `crates/token-dashboard-cli/src/lib.rs` — 2,960 lines, 4.9× the 600-line threshold; combines axum routing, DB queries, CSV/JSON serialization, cache-control logic. |

### High

| # | Area | Finding |
|---|------|---------|
| H1 | Rust / tauri | `crates/token-dashboard-tauri/src/main.rs` — 894 lines, mixes init, signals, port selection, IPC. |
| H2 | Tauri config | `crates/token-dashboard-tauri/tauri.conf.json:5` — `"security": { "csp": null }`. No CSP means inline-script injection is unrestricted in the webview. |
| H3 | Frontend state | `frontend/src/api-client.js` exports `window.MOCK_DATA`, `window.DATA_READY`, `window.RELOAD_DATA`; mutable module-level `currentRange`, `currentPromptQuery`. Implicit dependency for every consumer. |
| H4 | Frontend state | `frontend/src/components/widget.jsx` — 674 lines, 7+ `useEffect` hooks. High risk of stale closures and unnecessary re-renders. Hardest file to reason about in the frontend. |
| H5 | Frontend props | Topbar receives 7+ props (`tab`, `setTab`, `range`, `setRange`, `provider`, `setProvider`, `advancedMode`, …). Symptom of missing Context. |
| H6 | Frontend types | Zero TypeScript and zero PropTypes across 40+ files. Refactors are unverified. |

### Medium

| # | Area | Finding |
|---|------|---------|
| M1 | Rust / core | `crates/token-dashboard-core/src/queries.rs` — 1,029 lines. Single-responsibility (query builders) but at the limit; candidate for splitting per query family. |
| M2 | Rust / core | `crates/token-dashboard-core/src/scanner.rs` — 744 lines. Above threshold. |
| M3 | Cargo | No workspace `[lints]` block in root `Cargo.toml`. Each crate must duplicate clippy policy or inherit none. |
| M4 | Repo | No `CHANGELOG.md`. Release notes auto-generated on GitHub but not in the repo. |
| M5 | Frontend net | Fetch wrapper in `api-client.js` has no retry, no timeout, no AbortController. Range switches and unmounts can leak requests. |
| M6 | Frontend SSE | `sse-dispatch.js` exists but reconnect/backoff strategy not visible. |
| M7 | Frontend CSS | 120 inline `style={{…}}` usages alongside 815 `className`s. Mixed model; theming becomes brittle. |
| M8 | Frontend build | No code splitting in esbuild; one bundle. First-paint cost grows with the codebase. |
| M9 | A11y | Only 42 `aria-*` attributes across the dashboard; keyboard nav undocumented. |

### Low

| # | Area | Finding |
|---|------|---------|
| L1 | Rust / cli | 6 `.parse().unwrap()` on literal HTTP header strings (`lib.rs:2049–2166`). Safe but inconsistent. |
| L2 | Repo | No `rustfmt.toml`, no `clippy.toml`, no pre-commit hooks. CI is the only gate. |
| L3 | Frontend | 12 `console.log` calls leak into the prod bundle. |
| L4 | Docs | `docs/todo/*` and some `docs/superpowers/plans` are stale relative to current state. |
| L5 | Frontend deps | No `package-lock.json` committed in `frontend/`. CI does an unpinned install. |

### Strengths (do not touch)

- `cargo clippy --all-targets --workspace` is **zero warnings**.
- No SQL injection vectors — all dynamic SQL uses `?` binding; `format!` interpolates only internal column names.
- `token-dashboard-core` is well-factored: 20 small modules behind a 41-line `lib.rs`.
- No committed secrets; fixture tokens are `EXAMPLE` placeholders.
- Release pipeline covers Windows MSI, Linux deb/AppImage, macOS arm64/x64 DMG with hdiutil retry. Winget + Homebrew chained off it.
- Single `unsafe` block in `tauri/src/main.rs:769` (`set_var` before threads spawn) is justified and commented.

---

## Proposed phased refactor plan

Each phase is independently shippable behind tests + a green CI run. User picks the phases to execute; nothing edits until approved.

### Phase 1 — Safety net (no behavior change, ~half a session)

Goal: make later phases cheap and reversible.

- Add root `[workspace.lints.rust]` + `[workspace.lints.clippy]` to `Cargo.toml`; promote `unwrap_used`, `expect_used` (warn) outside tests.
- Add `rustfmt.toml` (group_imports, imports_granularity = "Crate") and `clippy.toml` (cognitive-complexity threshold).
- Add a `CHANGELOG.md` seeded from existing git tags.
- Commit `frontend/package-lock.json`.
- Wire `cargo-deny` + `cargo-audit` into the existing rust.yml workflow.

### Phase 2 — Lock down Tauri webview (security, small) (H2)

- Set a concrete CSP in `tauri.conf.json` (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*`).
- Verify the SSE consumer still reaches the embedded server under the new policy.
- One commit, easy to roll back.

### Phase 3 — Split `cli/src/lib.rs` (C1, biggest payoff)

Target module layout under `crates/token-dashboard-cli/src/`:

```
lib.rs                — re-exports + `app(state)` builder only
routes/
  mod.rs              — Router assembly
  overview.rs, sessions.rs, limits.rs, budget.rs, …
serialize/
  csv.rs, json.rs
cache.rs              — cache-control headers, ETag helpers
state.rs              — AppState, ctor, deps
sse.rs                — SSE bus + topic registry
errors.rs             — IntoResponse impls
```

- Migration is mechanical: cut by `axum::routing::*` calls; keep behavior identical.
- Existing `tests/endpoints.rs` (1,070 lines) acts as the integration safety net — no contract changes.
- Replace `.parse().unwrap()` on header literals with `HeaderValue::from_static`.

### Phase 4 — Split `tauri/src/main.rs` (H1)

```
main.rs               — `fn main` only
app.rs                — Tauri builder + plugin wiring
signals.rs            — ctrl-c / SIGTERM
port.rs               — free-port picker, static dir resolution
ipc.rs                — Tauri command handlers
```

- Move the `unsafe { set_var }` block to a clearly-named `init_static_dir_env()` helper at the top of `main` with the existing comment preserved.

### Phase 5 — Split `core/queries.rs` and `core/scanner.rs` (M1, M2)

- `queries/` submodule per family: `overview.rs`, `sessions.rs`, `tools.rs`, `models.rs`, `limits.rs`, `budget.rs`, `phase_split.rs`.
- `scanner/` submodule: `incremental.rs` (mtime + offset), `parse.rs` (JSONL), `dedup.rs` (streaming-snapshot per CLAUDE.md), `walk.rs`.

### Phase 6 — Frontend state model (H3, H4, H5)

- Introduce `frontend/src/state/` with one React Context per concern (`DataContext` replacing `window.MOCK_DATA`, `RangeContext`, `ProviderContext`).
- Migrate `widget.jsx` (the 674-line file) first as the proof; then `routes/overview.jsx`.
- Keep `window.RELOAD_DATA` as a thin shim during the transition; remove once all consumers are migrated.

### Phase 7 — Frontend API client (M5, M6)

- Replace ad-hoc `j(url)` with a single `apiFetch(url, { signal, retry, timeout })`.
- Wire `AbortController` to every consumer's `useEffect` cleanup.
- Add reconnect + exponential backoff to the SSE consumer.

### Phase 8 — Frontend types + lint (H6, L3)

- Add TypeScript in strict mode for new files; convert leaf components first (`Topbar`, KPI strip, `LimitWindow`) to `.tsx`.
- Add ESLint with `no-console` (warn), `react-hooks/exhaustive-deps` (error).
- Build script: keep esbuild, add `tsc --noEmit` to CI.

### Phase 9 — Styling consolidation (M7)

- Sweep inline `style={{…}}` into `styles.css` using existing theme tokens. No new dependencies.

### Phase 10 — A11y + nice-to-haves (M9, L4, L5)

- ARIA pass on interactive controls (tabs, sliders, table sort).
- Stale-doc sweep (`docs/todo/*`, `docs/superpowers/plans`).
- Frontend code splitting only if first-paint becomes measurable pain.

---

## Recommended order if user wants the maximum quality lift per session

1. Phase 1 + Phase 2 together (one session, fully safe).
2. Phase 3 (one session, biggest payoff, fully behind integration tests).
3. Phase 6 (one session, unlocks the rest of the frontend work).
4. Phase 4 + Phase 5 (one session, both are mechanical splits).
5. Phase 7, 8, 9, 10 — one each, in any order.

If the user wants to ship faster: Phase 1 → Phase 2 → Phase 3 covers the highest-impact items.
