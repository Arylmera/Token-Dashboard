# Changelog

All notable changes to Token Dashboard are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

Auto-generated GitHub release notes (with full per-PR detail) live at
<https://github.com/Arylmera/Token-Dashboard/releases>. This file captures the
human-curated highlights.

## [Unreleased]

## [4.1.3] - 2026-05-23

### Added
- Model-efficiency leaderboard (`/api/model_efficiency` + Overview card)
  ranking models by cost-per-token.
- Subscription-aware budget threshold alerts with remote-sync auto-pull.
- Multi-machine sync groundwork (`remote_sync`, `sync_snapshot`).

### Fixed
- Homebrew cask is now architecture-aware: the release pipeline hashes both
  the `aarch64` and `x64` DMGs and emits a per-arch `sha256`, so
  `brew install`/`brew upgrade` no longer fails with a checksum mismatch on
  Intel Macs (the cask URL served the x64 DMG while only the arm64 hash was
  published).

## [4.1.2] - 2026-05-21

### Changed
- Workspace lint policy centralised in root `Cargo.toml` (`[workspace.lints]`)
  and inherited by all crates; `rustfmt.toml` + `clippy.toml` checked in.
- `frontend/package-lock.json` is now tracked for reproducible installs.
- `crates/token-dashboard-cli/src/lib.rs` split into focused modules
  (2960 → 19 lines) for readability and quicker rebuilds.

### Fixed
- Long git project names are trimmed across all project columns (Overview,
  Token Sink, Budget) so wide repo paths no longer break table layout.

### Security
- `cargo-deny` + `cargo-audit` wired into the Rust CI workflow.
  `deny.toml` ignores the rust-unic / gtk-rs / proc-macro-error advisories
  pulled in transitively by tauri 2.x (no upstream fix yet).
- Tauri webview now ships a concrete Content Security Policy (replaces
  `"csp": null`).

## [4.1.1] - 2026-05-21
- Patch release on top of 4.1.0; see GitHub release notes for details.

## [4.1.0] - 2026-05-21
- Budget tab grouping + Cap UI polish.
- Auto-tag git projects + standalone remote-setup help window.

## [4.0.12] - 2026-05-17
- Bug-fix release.

## [4.0.11] - 2026-05-14

## [4.0.10] - 2026-05-14

## [4.0.9] - 2026-05-14

## [4.0.8] - 2026-05-14

## [4.0.7] - 2026-05-13

## [4.0.6] - 2026-05-12
- Multi-provider scaffold.
- SSE refresh fix.

## [4.0.5] - 2026-05-11

## [4.0.4] - 2026-05-10

## [4.0.3] - 2026-05-10

## [4.0.2] - 2026-05-10

## [4.0.1] - 2026-05-10

## [4.0.0] - 2026-05-10
- First Rust + Tauri release; replaces the 3.x Python + Electron stack.
- New crates: `token-dashboard-core` (scanner, db, queries, pricing),
  `token-dashboard-cli` (axum HTTP surface + SSE bus),
  `token-dashboard-tauri` (Tauri 2 desktop shell).
- React 18 frontend bundled with esbuild.

## Pre-4.0

The 3.x line (Python + Electron) and earlier are no longer maintained; their
release notes are preserved on GitHub.

[Unreleased]: https://github.com/Arylmera/Token-Dashboard/compare/v4.1.2...HEAD
[4.1.2]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.1.2
[4.1.1]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.1.1
[4.1.0]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.1.0
[4.0.12]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.12
[4.0.11]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.11
[4.0.10]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.10
[4.0.9]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.9
[4.0.8]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.8
[4.0.7]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.7
[4.0.6]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.6
[4.0.5]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.5
[4.0.4]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.4
[4.0.3]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.3
[4.0.2]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.2
[4.0.1]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.1
[4.0.0]: https://github.com/Arylmera/Token-Dashboard/releases/tag/v4.0.0
