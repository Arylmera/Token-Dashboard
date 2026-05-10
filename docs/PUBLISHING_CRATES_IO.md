# Publishing `token-dashboard-core` to crates.io

Step-by-step plan for shipping the core library to crates.io. Scope: **`token-dashboard-core` only** — `cli` and `tauri` stay as product binaries, distributed via GitHub Releases.

---

## Phase 0 — Prerequisites

1. **Create a crates.io account** at https://crates.io/ (sign in with GitHub).
2. **Generate an API token** at https://crates.io/settings/tokens — scope: `publish-new` + `publish-update`.
3. **Login locally** (token stored in `%USERPROFILE%\.cargo\credentials.toml`):
   ```bash
   cargo login <token>
   ```
4. **Confirm the name is free**:
   ```bash
   cargo search token-dashboard-core
   ```
   If taken, pick a fallback (e.g. `claude-token-dashboard-core`) and update `crates/token-dashboard-core/Cargo.toml` `name`.

---

## Phase 1 — Metadata hardening

Goal: make the crate self-describing on the registry page.

### 1.1 Workspace `Cargo.toml`

Add shared metadata to `[workspace.package]`:

```toml
[workspace.package]
edition = "2021"
license = "MIT"
repository = "https://github.com/Arylmera/Token-Dashboard"
authors = ["Guillaume Lemer <guillaume.lemer.be@gmail.com>"]
homepage = "https://github.com/Arylmera/Token-Dashboard"
rust-version = "1.75"   # verify with `cargo msrv` or pick the version you build with
```

### 1.2 `crates/token-dashboard-core/Cargo.toml`

Replace the `[package]` block with:

```toml
[package]
name = "token-dashboard-core"
version = "4.0.0"
edition.workspace = true
license.workspace = true
repository.workspace = true
authors.workspace = true
homepage.workspace = true
rust-version.workspace = true
description = "Scanner, sqlite store, pricing, and analytics for Claude Code JSONL session transcripts."
readme = "README.md"
keywords = ["claude", "tokens", "analytics", "anthropic", "telemetry"]
categories = ["command-line-utilities", "development-tools", "parser-implementations"]
documentation = "https://docs.rs/token-dashboard-core"
include = [
    "src/**/*.rs",
    "Cargo.toml",
    "README.md",
    "LICENSE",
]
```

### 1.3 Per-crate `LICENSE` and `README.md`

`cargo publish` only ships files inside the crate directory.

```bash
cp LICENSE crates/token-dashboard-core/LICENSE
```

Write a focused `crates/token-dashboard-core/README.md` (do not copy the root README — that documents the desktop app). Cover:
- What `token-dashboard-core` is (parser + analytics library, not the desktop app).
- Quick `Cargo.toml` add snippet.
- One usage example: open a `Db`, run `Scanner::scan_all`, query `overview`.
- Link back to the repo for the full app.

---

## Phase 2 — API audit

Goal: ensure the public API is intentional. Once published, every breaking change forces a major bump.

### 2.1 Inventory the public surface

```bash
cargo doc -p token-dashboard-core --no-deps --open
```

Walk the docs page. For each `pub` item ask:
- Is this meant to be used externally?
- If not, downgrade to `pub(crate)`.

### 2.2 Document public items

Add `///` rustdoc to every remaining `pub` item. Minimum: one-line summary. Examples for the top 3–4 entry points (`Db::open`, `Scanner::scan_all`, `queries::overview`).

### 2.3 Lints

Add to `crates/token-dashboard-core/src/lib.rs`:

```rust
#![warn(missing_docs)]
#![warn(rustdoc::broken_intra_doc_links)]
```

Fix or `#[allow(...)]` exceptions until clean.

### 2.4 Feature flags

Confirm `default = ["http"]` is what you want shipped. The `http` feature pulls `ureq`, which most library consumers won't need. **Recommendation:** flip default off — `default = []` — so library users opt in.

---

## Phase 3 — Verify the package

### 3.1 Dry-run

```bash
cargo publish -p token-dashboard-core --dry-run
```

Output lists every file in the tarball. Confirm:
- `LICENSE` and `README.md` are present.
- No stray test fixtures, no `target/`, no `.db` files.
- Tarball under 10 MB (crates.io hard limit).

### 3.2 Inspect the tarball

```bash
cargo package -p token-dashboard-core --list
```

Eyeball the file list. Adjust `include = [...]` if anything unwanted appears.

### 3.3 Build the packaged form

```bash
cargo package -p token-dashboard-core
cd target/package/token-dashboard-core-4.0.0
cargo build
cargo test
```

This catches bugs where the published crate references files that exist in the repo but not in the package.

---

## Phase 4 — Quality gates

Run from repo root:

```bash
cargo test --workspace
cargo fmt --check
cargo clippy --all-targets --workspace -- -D warnings
cargo doc -p token-dashboard-core --no-deps
```

All must pass before publishing.

---

## Phase 5 — Publish

### 5.1 Tag the release

```bash
git add -A
git commit -m "chore: prepare token-dashboard-core 4.0.0 for crates.io"
git tag core-v4.0.0
git push origin develop --tags
```

### 5.2 Publish

```bash
cargo publish -p token-dashboard-core
```

Output ends with a link to https://crates.io/crates/token-dashboard-core. **This is irreversible** — versions can be yanked but never deleted or overwritten.

### 5.3 Verify

- Visit the crates.io page, confirm description, README, links render.
- Wait ~5 min for docs.rs to build, then visit https://docs.rs/token-dashboard-core.
- If docs.rs fails, check the build log linked from the page; common causes: missing system deps, `missing_docs` lint, broken intra-doc links.

---

## Phase 6 — Post-publish hygiene

1. **Add a crates.io badge** to root `README.md`:
   ```markdown
   [![crates.io](https://img.shields.io/crates/v/token-dashboard-core.svg)](https://crates.io/crates/token-dashboard-core)
   ```
2. **Document the release process** in `docs/RELEASING.md` so future versions follow the same steps.
3. **Decide on a versioning policy.** SemVer is enforced by the ecosystem; any breaking API change requires `5.0.0`. Patch the README with a "stability" note if `core` is still evolving.

---

## Future: publishing `cli` and `tauri`

Skip unless there is real demand. If pursued later:

- `cli`: change `token-dashboard-core = { path = "..." }` to `{ path = "...", version = "4.0.0" }`. Publish after `core` propagates (~30s wait).
- `tauri`: same dual-path-version trick, plus pre-built `frontend/dist/app.js` committed or generated in `build.rs`, plus an `include = [...]` listing every non-Rust asset (icons, `tauri.conf.json`, `frontend/index.html`, `frontend/dist/**`). Recommended distribution channel remains GitHub Releases — crates.io is a poor fit for desktop apps.

---

## Rollback

If a published version is broken:

```bash
cargo yank --version 4.0.0 -p token-dashboard-core
```

Yanking blocks new dependents from picking the version; existing `Cargo.lock` files keep working. Then publish `4.0.1` with the fix.
