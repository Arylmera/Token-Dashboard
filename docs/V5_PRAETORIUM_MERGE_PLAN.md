# V5 — Praetorium Merge Plan

Folding **Praetorium** (live Claude Code session command post) into **Token
Dashboard** as a single desktop app, shipped as **v5.0**. Praetorium's repo is
archived after the merge and redirected here.

> Status: **planning**. This document freezes the design decisions agreed up
> front. Code lands in follow-up commits on `claude/token-dashboard-merge-vdey5`.

## Why this is tractable

The two apps already converged on the same foundations — Praetorium's recent
`React + esbuild port and core/cli/tauri workspace split (#34)` was groundwork
for exactly this. The merge is **integration, not a rewrite**.

| | Token Dashboard (v4.2.1) | Praetorium (v0.8.3) |
|---|---|---|
| Workspace | `core / cli / tauri` | `core / cli / tauri` — same |
| Shell | Tauri 2 | Tauri 2 |
| UI | React 18 + esbuild, plain JSX | React 18 + esbuild, plain JSX |
| Tests | `cargo test` + `node --test` | `cargo test` + `node --test` |
| Data source | `~/.claude/projects/**/*.jsonl` | same |
| Theme tokens | `--bg --panel --accent --good …` | identical token names |
| Transport | embedded axum HTTP + SSE | pure Tauri IPC (`invoke` + `Channel`) |
| Storage | SQLite (rusqlite) + incremental scanner | none (live fs reads) |
| Process model | none — passive, read-only | spawns `claude` CLI + `notify` watcher |
| Nav | `NavRail` + hash router, `ROUTES` map | `ViewSwitcher` + `view-store`, `ROUTES` map |
| CSS scope | `.dir-a-root` + `theme-X` classes | `.pr-root` + `data-theme` attr |

## Decisions (locked)

1. **Version:** ship as **v5.0**. Praetorium repo archived + redirected here.
2. **Desktop only.** Drop `praetorium-cli` entirely. Port only
   `praetorium-core` (pure library) and the live modules of
   `praetorium-tauri` (`process.rs`, `session_watch.rs`, command wrappers).
3. **Product framing — "still mostly read-only" (Option A).** The analytics
   tabs stay 100% passive: they only ever *read* the JSONL Claude already
   wrote. The Live feature — which *spawns* `claude` — is a clearly labelled,
   opt-in tab ("this runs Claude for you"). The README keeps its
   "100% local · no telemetry · no login" promise, qualified so launching
   Claude is an explicit, user-initiated action and never automatic.
4. **Live = one rail item.** A single **"Live"** entry in the nav rail opens
   Praetorium's existing Console / Cockpit / Explorer sub-switcher underneath.
   This keeps TD's analytics tabs uncluttered.
5. **Pop-out window.** The Live view can detach into its own Tauri
   `WebviewWindow`. Same process, same backend, same components — just a
   second host. Docked tab collapses to a "Live is open in its own window"
   state; closing the window re-docks.
6. **Transport for v1: keep both.** Live tabs keep Tauri IPC; analytics tabs
   keep `/api/*` + SSE. Unifying onto one transport is deferred.

## Architecture after the merge

```
crates/
  token-dashboard-core/    unchanged — scanner, db, queries, pricing, tips…
  praetorium-core/         NEW workspace member. Pure library: parser,
                           events, session_parse, sessions, vault. No Tauri,
                           no db, no async runtime. Keeps its own tests.
  token-dashboard-cli/     unchanged — axum router + SSE bus, /api/* surface.
  token-dashboard-tauri/   GAINS the live modules:
                             process.rs        — spawns `claude`, streams
                                                 ClaudeEvents over a Channel.
                             session_watch.rs  — notify watcher on
                                                 ~/.claude/projects/.
                           Both depend on praetorium-core. Single process —
                           axum server + Tauri commands/channels coexist.
  (praetorium-cli)         DROPPED — desktop only.

frontend/
  src/
    routes/                + live/ — Praetorium's Console/Cockpit/Explorer,
                             namespaced. Mounted under one "live" route.
    components/            + live components (cockpit, console, explorer,
                             command-palette, view-switcher) namespaced to
                             avoid colliding with TD's own ambient-canvas /
                             special-chrome / settings.
    stores/                + Praetorium's createStore modules (self-contained
                             ES modules — coexist with TD's window globals).
    lib/                   + Praetorium's pure logic (graph, layout,
                             wikilinks, agentNaming, cockpitView, …).
    live-window.js         NEW — pop-out / re-dock controller (WebviewWindow).
    live-event-bus.js      NEW — routes watcher Channel events to whichever
                             host (docked tab or detached window) owns Live.
```

## The pop-out detail (the one real wrinkle)

A second `WebviewWindow` is the same Rust process, so the axum server and the
Tauri commands/channels are already reachable from it — no second server, no
duplicated backend state. But Praetorium's live watcher emits over a Tauri
`Channel` to "the frontend." With two possible hosts we route those events
through a small **event bus** (`live-event-bus.js`) so they reach whichever
window currently owns the Live view (broadcast to both if both are open).
Pop-out spawns a window pointed at the same bundle with a `?view=live` flag (or
a dedicated entry); the rail item shows a "bring it back" state until the window
closes.

## Theme unification (cheap, high payoff)

Both stylesheets already share the token layer (`--bg`, `--panel`, `--accent`,
`--good`, `--warn`, …) and overlap on theme *names* (forge, forest, dusk,
ocean, matrix, rose, paper). The selector plumbing differs:
`.dir-a-root.theme-X` vs `.pr-root[data-theme="X"]`. v1 approach: nest
Praetorium's `.pr-*` rules under TD's root and map the active TD theme class to
a `data-theme` attribute once, so both stylesheets read the same active tokens.
A full single-stylesheet merge is a follow-up nice-to-have.

## Work breakdown

1. **Workspace:** add `praetorium-core` as a member; wire it into
   `token-dashboard-tauri`'s deps. Drop `praetorium-cli`. `cargo build
   --workspace` green.
2. **Backend live modules:** move `process.rs` + `session_watch.rs` into
   `token-dashboard-tauri`, register the `#[tauri::command]`s and channel
   plumbing. `cargo test --workspace` green.
3. **Frontend port:** copy Praetorium `components/`, `stores/`, `lib/`,
   `themes` deltas under `frontend/src/`, namespaced. `node --test` green.
4. **Nav + routing:** add the "Live" rail item to `nav-items.js`; register the
   route in `app.jsx`; mount Praetorium's sub-switcher under it.
5. **Pop-out:** `live-window.js` + `live-event-bus.js`; detach/re-dock flow.
6. **Themes:** nest `.pr-*`, map active theme → `data-theme`.
7. **Branding/version:** bump the 4 version spots to `5.0.0`; README to the
   Option-A framing; archive note for the Praetorium repo.

## Verification

```bash
cargo build --workspace
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cd frontend && npm install && npm run build && node --test
```

Plus a manual smoke test: `cargo run --release -p token-dashboard-tauri`,
confirm analytics tabs load read-only and the Live tab can launch + watch a
session, docked and popped-out.

## Deferred (not in v1)

- Transport unification (port Live onto axum/SSE).
- Parser unification (TD `scanner.rs` and Praetorium `parser.rs` both read the
  same JSONL — eventually one read layer).
- Single merged stylesheet.
- Toward "active command post" framing (Option B) if users embrace Live.
