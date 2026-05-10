# Token Dashboard 4.0 — Rust + Tauri Rewrite Plan

Draft. Not a commitment. This document captures the rationale, scope, and a phased migration path for rewriting the project in Rust (backend) and Tauri (desktop shell) as a 4.0 release. The current 3.x line (Python stdlib backend + Electron shell) stays maintained until 4.0 reaches feature parity.

## Why 4.0 (and why now)

The 3.x architecture has two ceilings worth naming:

1. **Scanner throughput.** `token_dashboard/scanner.py` is incremental and correct, but pure-Python JSONL parsing scales linearly with `~/.claude/projects/` size. Heavy users already have multi-hundred-megabyte transcript trees; a Rust scanner with `serde_json` + `memmap2` can ingest the same tree 5–20× faster while using a fraction of the memory.
2. **Distribution weight.** The Electron shell ships ~150 MB and idles at 200–400 MB RAM. For an always-on tray app, both numbers are uncomfortable. Tauri replaces the Chromium runtime with the OS webview, cutting installer size to ~5–10 MB and idle RAM to ~50 MB.

A rewrite also lets us shed accumulated 3.x compromises:

- The "stdlib only" constraint exists because `pip install` is friction. Rust binaries have no equivalent friction — Cargo crates are statically linked. The constraint becomes obsolete.
- The Electron tray + dock-badge controller (`electron/src/tray.js`) is duplicated logic that Tauri ships natively.
- The SSE refresh client (`electron/src/sse-client.js`) is only needed because the renderer and main process are separated. Tauri's IPC removes the need for an HTTP server in the desktop case (we keep the HTTP server for headless / browser use).

## Non-goals

- **Not a feature rewrite.** 4.0 ships at parity with 3.x. New features go on top after 4.0 lands.
- **Not a UI rewrite.** The React 18 frontend (`frontend/src/`) is portable as-is. esbuild stays. Only `api-client.js` adapts (HTTP in browser mode, Tauri IPC in desktop mode).
- **Not a SQLite schema change.** The existing `~/.claude/token-dashboard.db` is read with `rusqlite` against the same schema. 3.x → 4.0 is a binary swap, not a data migration.
- **Headless mode survives.** `cli dashboard` still launches an HTTP server on `127.0.0.1:8080`. The Tauri shell is an additional surface, not a replacement.

## Target architecture

```
┌──────────────────────── 4.0 ────────────────────────┐
│                                                     │
│  ┌──────────────────┐    ┌──────────────────────┐   │
│  │ tauri shell (rs) │    │ headless cli (rs)    │   │
│  │  - tray + badge  │    │  - axum http server  │   │
│  │  - window mgmt   │    │  - sse stream        │   │
│  │  - ipc bridge    │    └──────────────────────┘   │
│  └────────┬─────────┘                ▲              │
│           │                          │              │
│           ▼                          │              │
│  ┌─────────────────────────────────────────────┐    │
│  │ core crate (token_dashboard_core)           │    │
│  │  - scanner    (serde_json + memmap2)        │    │
│  │  - db layer   (rusqlite)                    │    │
│  │  - endpoints  (overview, prompts, …)        │    │
│  │  - tips engine                              │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ frontend (unchanged: react 18 + esbuild)    │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Crates and dependencies

| Concern              | 3.x (Python)            | 4.0 (Rust)                          |
| -------------------- | ----------------------- | ----------------------------------- |
| HTTP server          | stdlib `http.server`    | `axum` + `tokio`                    |
| SSE                  | manual                  | `axum::response::sse`               |
| SQLite               | stdlib `sqlite3`        | `rusqlite` (bundled)                |
| JSON                 | stdlib `json`           | `serde_json`                        |
| File watching        | mtime polling           | `notify` (with mtime fallback)      |
| Memory-mapped reads  | n/a                     | `memmap2`                           |
| Desktop shell        | Electron                | Tauri 2.x                           |
| HTTP client (limits) | stdlib `urllib.request` | `reqwest` (rustls)                  |
| Tray / dock badge    | Electron APIs           | `tauri::tray` + `tauri-plugin-*`    |

All crates are MIT/Apache-2.0 and statically linked. No runtime dependency on the user's machine beyond the OS webview that Tauri requires (WebView2 on Windows ships with Win10+; WKWebView on macOS is system; webkit2gtk on Linux is a packaging dependency).

### Workspace layout

```
crates/
  token-dashboard-core/   # scanner, db, endpoints, tips
  token-dashboard-cli/    # headless `cli dashboard` binary
  token-dashboard-tauri/  # desktop shell (depends on core)
frontend/                 # unchanged
docs/
```

## Phased migration

Each phase ships a usable artifact. 3.x stays on `main`; 4.0 work happens on a long-lived `v4` branch with periodic merges from `main` to keep the frontend and pricing data in sync.

### Phase 1 — Core crate (scanner + db)

**Scope.** Port `token_dashboard/scanner.py` and `token_dashboard/db.py` to Rust. Same schema, same incremental semantics (per-file mtime + byte offset in `files` table, `(session_id, message_id)` dedup key, `_evict_prior_snapshots` behavior preserved).

**Validation.** A `parity` binary that runs both scanners against the same `~/.claude/projects/` and asserts identical row counts and aggregate token totals. Ships as a CI gate.

**Risk.** Streaming-snapshot dedup is subtle (see CLAUDE.md). Port the unit tests covering `_evict_prior_snapshots` first, then the scanner.

**Exit criteria.** All 68 existing Python unit tests have Rust equivalents passing. Parity binary green on the maintainer's local transcript tree.

### Phase 2 — Endpoints + headless server

**Scope.** Port `token_dashboard/server/endpoints/{state,data,budget,sources,io}.py` and `routes.py` to `axum` handlers. Preserve `docs/API_CONTRACT.md` byte-for-byte: same paths, same JSON shapes, same query params.

**Validation.** Contract tests that hit each endpoint on both 3.x and 4.0 and `diff` the JSON output. Run in CI against a checked-in fixture transcript tree.

**Risk.** SSE wire format. Tokio-axum SSE differs subtly from the hand-rolled Python implementation around heartbeat timing; the existing `electron/src/sse-client.js` reconnect logic is the spec.

**Exit criteria.** `frontend/` runs unchanged against the Rust server. All seven tabs render correctly.

### Phase 3 — Tauri shell

**Scope.** Replace `electron/main.js` and `electron/src/{backend,window,tray,sse-client}.js` with a Tauri shell. The shell boots the embedded HTTP server on a random localhost port and points the webview at it (avoids needing to dual-mode `api-client.js`).

**Validation.** Manual QA matrix: Windows 11, macOS 14, Ubuntu 22.04 / Fedora. For each: cold-start time, idle RAM, glass mode rendering, all 14 themes, tray menu, dock badge, SSE staying connected for 1 hour.

**Risk.** webkit2gtk on Linux. Backdrop filters, some CSS grid features, and long-lived SSE all have known quirks. Plan a `--no-glass` fallback and a polling fallback for SSE if webkit2gtk drops connections.

**Exit criteria.** Tauri build artifacts (.msi, .dmg, .AppImage / .deb) launch and reach feature parity with the Electron build on the QA matrix.

### Phase 3.5 — CI / build pipeline

**Scope.** Expand CI to cover the Rust workspace and produce signed Tauri artifacts on every tag. Runs in parallel with Phase 3 work but lands before Phase 4 cutover.

**Pipelines.**

| Pipeline             | Trigger                | Steps                                                                                       | Cache                                |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------ |
| `lint-rust`          | every PR               | `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo deny check`                      | `~/.cargo/registry`, `target/`       |
| `test-core`          | every PR               | `cargo test -p token-dashboard-core` on linux-x64                                           | sccache                              |
| `test-cli`           | every PR               | `cargo test -p token-dashboard-cli` on linux-x64                                            | sccache                              |
| `parity-scanner`     | every PR touching core | runs Phase 1 parity binary against checked-in fixture transcript tree; diffs row counts    | fixture is git-LFS                   |
| `parity-endpoints`   | every PR touching core | spins up 3.x Python server + 4.0 Rust server; `diff` JSON output for each `/api/*` route   | fixture shared with parity-scanner   |
| `test-frontend`      | PR touches frontend    | unchanged from 3.x                                                                          | npm cache                            |
| `build-tauri`        | tag `v4.*`             | matrix: `windows-2022 x64`, `macos-14 x64+arm64`, `ubuntu-22.04 x64`; `tauri build`         | sccache + tauri build cache          |
| `sign-and-release`   | tag `v4.*`             | code-sign Windows (.msi) + macOS (.dmg notarized); attach to GitHub Release                | n/a                                  |

**Build matrix.** Six artifacts per release: `Token-Dashboard_4.x.x_x64.msi`, `Token-Dashboard_4.x.x_x64.dmg`, `Token-Dashboard_4.x.x_aarch64.dmg`, `Token-Dashboard_4.x.x_amd64.deb`, `Token-Dashboard_4.x.x_amd64.AppImage`, source tarball. Linux arm64 is deferred until a real user asks for it.

**Caching strategy.** sccache with S3 backend (or GitHub Actions cache) is mandatory. A cold Rust build of the workspace is ~6–10 minutes per platform; warm cache drops it to ~1–2. Without caching, the build matrix would consume the bulk of CI minutes.

**Secrets.** Three new secrets: `WINDOWS_CODESIGN_PFX` (base64 PFX + password), `APPLE_CERTIFICATE` + `APPLE_API_KEY` (notarization), `TAURI_SIGNING_PRIVATE_KEY` (updater signing). All scoped to the release pipeline only, never PR pipelines from forks.

**Branch protection.** `lint-rust`, `test-core`, `test-cli`, `parity-scanner`, `parity-endpoints` are required checks on the `v4` branch and on `main` post-cutover. `build-tauri` is informational on PRs but required on tags.

**CI cost budget.** Estimate ~2× current minutes during overlap (3.x and 4.0 both run); ~1.5× steady-state post-cutover. If GitHub-hosted minutes become a problem, move `build-tauri` to a self-hosted Linux runner and keep macOS/Windows on GitHub.

**Exit criteria.** A clean tag of `v4.0.0-rc.1` produces all six artifacts, signed and notarized, attached to a GitHub draft release, with parity tests green.

### Phase 4 — Cutover

**Scope.** Promote `v4` to `main`. Archive `electron/` to `electron-legacy/` and remove from default builds. Update `README.md`, `CLAUDE.md`, and release artifacts. Tag `v4.0.0`.

**Validation.** A 30-day overlap window where both 3.x and 4.0 builds are downloadable. Telemetry stays off (per local-only conventions), so feedback comes from the GitHub issue tracker.

**Exit criteria.** No regressions reported against 4.0 for two weeks. `develop` becomes the 4.x line.

## Risks and mitigations

Risks are ordered by likelihood × blast radius. Each entry names the failure mode, the early-warning signal we'll watch for, and the concrete fallback we ship if the risk fires. "Trip wire" is the metric that tells us the mitigation needs to activate.

### R1 — webkit2gtk rendering or SSE breakage on Linux

**Failure mode.** Glass mode (backdrop-filter), some grid layouts, or long-lived SSE connections misbehave on webkit2gtk. The user sees a broken theme, frozen charts, or stale data.

**Likelihood.** Medium-high. webkit2gtk lags Chromium by ~12 months on CSS features and has a documented history of dropping idle long-poll connections.

**Trip wire.** Phase 3 manual QA on Ubuntu 22.04 / Fedora 40. Any of: glass shimmer artifacts, theme color drift, or SSE reconnect storms in a 1-hour idle test.

**Mitigation, layered.**
1. Ship a `--no-glass` startup flag and an in-app toggle that disables backdrop-filter and falls back to flat panels. Already cheap to add — `.dir-a-root.is-glass` is the single class that gates it.
2. Build a polling fallback for `/api/stream` (3-second `EventSource` → `fetch` polling) gated behind a runtime probe that detects SSE disconnects in the first 90 seconds.
3. Last resort: on Linux, ship the headless HTTP server + a desktop entry that opens the user's default browser. Tauri shell stays as the Windows/macOS path. Document this in the README so Linux users aren't surprised.

### R2 — Scanner parity drift

**Failure mode.** The Rust scanner's row count or token totals diverge from the Python scanner. Users on the same transcripts see different numbers between 3.x and 4.0.

**Likelihood.** Medium. The streaming-snapshot dedup logic is the most subtle code in the project (see CLAUDE.md `_evict_prior_snapshots`).

**Trip wire.** `parity-scanner` CI job. Any non-zero diff in row count, total input tokens, total output tokens, or per-session aggregates against the fixture tree.

**Mitigation.**
1. Port the Python unit tests to Rust *first*, before any scanner code. Tests are the spec.
2. Keep the parity binary in `crates/token-dashboard-core/examples/parity.rs` as a permanent CI gate, not just a Phase 1 tool.
3. Maintain a curated fixture transcript tree under `tests/fixtures/parity/` (git-LFS) that exercises every observed JSONL shape: streaming snapshots, subagent dispatches, tool-use blocks with empty `usage`, mid-message disconnects.
4. If parity drifts post-launch, the headless 3.x server stays buildable from `electron-legacy/` for one full release cycle so users can A/B their own data.

### R3 — Endpoint contract drift

**Failure mode.** A `/api/*` response shape changes during the port. The frontend renders blank or wrong values for an entire tab.

**Likelihood.** Medium. `serde` defaults differ from Python `json.dumps` (field ordering, `null` vs missing key, integer vs float for whole numbers).

**Trip wire.** `parity-endpoints` CI job diffs every endpoint's JSON output between 3.x and 4.0 against the fixture tree. Any diff fails the PR.

**Mitigation.**
1. Promote `docs/API_CONTRACT.md` from descriptive to normative — every endpoint gets an explicit JSON schema, kept in `docs/api-schemas/*.json`. Both 3.x and 4.0 validate against it in tests.
2. Add a `serde` test layer that round-trips real captured responses through the Rust types and asserts byte-equal output.
3. If a diff is found post-launch and is not user-facing (e.g., field ordering), patch 3.x to match 4.0 to preserve the contract.

### R4 — Build matrix cost / CI minute exhaustion

**Failure mode.** Three-platform Rust + Tauri builds eat the GitHub Actions minute budget. Maintainers stop running CI on PRs to save minutes; quality drops.

**Likelihood.** Medium. A cold workspace build is ~10 min per platform; six-artifact release is ~30–60 min uncached.

**Trip wire.** Monthly minute usage report. Threshold: 70% of plan limit two months running.

**Mitigation.**
1. sccache with shared cache backend from day one (Phase 1, not Phase 3.5).
2. Split CI: PR pipelines run only `lint-rust` + `test-core` + `test-cli` + parity tests on Linux. Multi-platform build runs only on `v4` branch pushes and tags.
3. If still over budget, move `build-tauri` to a self-hosted Linux runner (macOS and Windows have to stay GitHub-hosted for code-signing certificate access).
4. Last resort: drop Linux arm64 from the matrix until a user asks for it (it's already deferred in Phase 3.5).

### R5 — Code-signing or notarization regression

**Failure mode.** Apple notarization rejects the build, or the Windows certificate expires unnoticed. A release goes out unsigned and SmartScreen / Gatekeeper blocks users.

**Likelihood.** Low-medium. Apple's notarization rules shift; PFX certs expire.

**Trip wire.** A pre-release smoke test that downloads the artifact and runs Gatekeeper / SmartScreen against it. Cert expiry calendar reminder 60 days out.

**Mitigation.**
1. Notarization is part of the `sign-and-release` CI job and must succeed before the release is published — not an afterthought.
2. Cert expiry is tracked in a single `docs/RELEASE_RUNBOOK.md` with a calendar reminder.
3. If a release ships unsigned by accident, the runbook covers republishing as `4.x.x+1` rather than re-signing in place.

### R6 — Schema migration during port window

**Failure mode.** A schema migration lands in 3.x mid-port. The Rust scanner now reads an old schema version, returns wrong data or crashes on startup.

**Likelihood.** Medium. The 4.0 timeline is months; schema work doesn't pause for it.

**Trip wire.** Any commit on `main` that touches `token_dashboard/db.py` `_migrate_*` functions.

**Mitigation.**
1. Schema migration freeze is *not* practical, so instead: every migration on 3.x ships with a paired Rust port to `crates/token-dashboard-core/src/db/migrations.rs` in the same PR. Branch protection enforces a label `needs-rust-port` that blocks merge to `main` until the Rust mirror exists.
2. The parity-scanner CI job runs against multiple schema versions to catch silent drift.
3. A migration version table (`PRAGMA user_version`) is the single source of truth; the Rust loader refuses to start if it sees a version it doesn't know.

### R7 — Tauri auto-updater abuse / supply-chain compromise

**Failure mode.** The updater signing key leaks; an attacker pushes a malicious update to all users.

**Likelihood.** Low, but irrecoverable if it fires.

**Trip wire.** Any unexplained access to the GitHub Actions release pipeline, key-rotation overdue, or the public key in the binary not matching the signed `latest.json`.

**Mitigation.**
1. The updater signing key lives only in GitHub Actions secrets, never on a developer laptop.
2. Key rotation runbook documented before 4.0 ships; rotation tested on a `v4.0.0-rc` build.
3. Default the updater to **off**. User opts in via Settings. Shipping without an auto-updater is acceptable for 4.0 — manual update from the GitHub Release page is fine for an early adopter audience.
4. If we later enable updates by default, publish the public key in `README.md` so users can verify the binary out-of-band.

### R8 — User confusion during 3.x / 4.0 overlap

**Failure mode.** Users run both versions, both versions write to `~/.claude/token-dashboard.db`, and changes from one corrupt the other's state.

**Likelihood.** Medium during the 30-day overlap window.

**Trip wire.** GitHub issues mentioning "missing data" or "duplicate sessions" during overlap.

**Mitigation.**
1. 4.0 reads from the same DB but takes a brief WAL-mode write lock during scans; 3.x already does the same. Concurrent writes are safe by SQLite design — but document it explicitly in the 4.0 release notes.
2. The 4.0 binary detects a 3.x server already running on `127.0.0.1:8080` and offers a clear error rather than racing for the port.
3. README adds a "running both" section for the overlap window.

### Pricing data

`pricing.json` stays a single shared file, read by both Python and Rust. No risk, no migration, listed here only so a future reader doesn't ask.

## What we explicitly defer

- Embedded subprocess-free Python interop (e.g., PyO3 to keep the existing scanner). Considered and rejected — it preserves the perf ceiling and adds a Python runtime to the Tauri bundle.
- A single-binary "no webview" TUI mode. Tempting, but the entire UX is the dense, themed dashboard. A TUI would be a different product.
- Replacing React with a Rust UI framework (Dioxus, Leptos). The current React app is mature, themed, and not the bottleneck.

## Sizing

Roughly **L–XL**. Phase 1 is the only phase with real semantic risk; Phases 2 and 3 are mostly mechanical with QA tail. Wall-clock estimate, single contributor at part-time pace: 2–3 months for Phases 1–2, plus 1 month for Phase 3 and cutover.
