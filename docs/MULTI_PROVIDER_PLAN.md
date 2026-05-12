# Multi-Provider Support — Codex & Ollama

Plan to extend Token Dashboard beyond Claude Code transcripts. Target providers (phase 1): **OpenAI Codex CLI**, **Ollama**. Architecture leaves room for Cursor, Gemini CLI, Aider, etc.

Naming note: `sources.rs` already owns "attached source DB" (uploaded sibling `.db` files). To avoid the collision this plan uses **Provider** for the new abstraction.

---

## 1. Goals & non-goals

**Goals**
- Unified Overview/Projects/Models views across Claude, Codex, Ollama.
- Per-provider cost (Claude, Codex paid) and per-provider token-only stats (Ollama, free local).
- Incremental ingest — same `files (path, mtime, bytes_read)` watermark model.
- Zero regression for existing Claude users; default UX unchanged when only Claude data exists.

**Non-goals (phase 1)**
- Editing/tagging cross-provider sessions in unified views.
- Subagent attribution outside Claude (Codex/Ollama have no subagent concept).
- Cache analytics for providers without cache reporting (Ollama; Codex partial).
- Tips engine rewrites — tips stay Claude-scoped for v1, gated by `provider='claude'`.

---

## 2. Data shape per provider

### Claude Code (existing)
- Path: `~/.claude/projects/<slug>/<session>.jsonl`
- Per-message: `message.usage.{input,output,cache_creation,cache_read}_input_tokens`, `message.model`, `message.id`, `parentUuid`, `isSidechain`.
- Cost: known via `pricing.json`.

### OpenAI Codex CLI
- Path: `~/.codex/sessions/<session>.jsonl` (also `~/.codex/history.jsonl` for cross-session prompts).
- Per-message (rough): `{role, content, ts, model, usage: {prompt_tokens, completion_tokens, total_tokens}}`. No cache fields. No `message_id` in older versions → fall back to a `(session_id, ordinal)` synthetic key.
- Cost: needs OpenAI pricing table. Pull from `pricing.json` extension (`gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`, …).
- No streaming-snapshot dedup — Codex writes one terminal message; treat every record as final.

### Ollama
- No on-disk transcript. Two ingest options:
  1. **Tail Ollama server logs** (`OLLAMA_HOST` access log) — fragile, format drifts.
  2. **Proxy mode** — optional shim binary `td-ollama-proxy` users point their client at; logs `prompt_eval_count`/`eval_count` into a JSONL we own. Off by default.
- Cost: $0 (local), but track tokens + wall-time for "would-have-cost" comparison against `claude-haiku-4-5` etc.
- Model id from `/api/tags` (e.g. `llama3.1:8b`).

---

## 3. Schema changes

Single new column on `messages` (and `tool_calls`, `files`):

```sql
ALTER TABLE messages ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE tool_calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE files ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
CREATE INDEX idx_messages_provider ON messages(provider);
```

Default `'claude'` makes the migration a no-op for existing DBs — every current row is Claude.

**Dedup key extension.** Current unique constraint is informal `(session_id, message_id)` enforced in scanner. Extend to `(provider, session_id, message_id)`. For Codex (no real `message_id`) synthesize `cdx-<ordinal>`; for Ollama proxy synthesize `oll-<ulid>`.

**No new tables.** Resist the urge — providers share enough columns. `tool_calls.tool_name` becomes "shell"/"apply_patch" for Codex, NULL-ish for Ollama. Provider-specific fields (e.g. Codex `reasoning_tokens`) ride in a new generic `extras_json` TEXT column rather than typed columns.

---

## 4. Rust trait

`crates/token-dashboard-core/src/providers/mod.rs`:

```rust
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;            // "claude" | "codex" | "ollama"
    fn root_dir(&self) -> Option<PathBuf>;    // discovery hint
    fn scan(&self, db: &mut Connection, opts: &ScanOpts) -> Result<ScanReport>;
}

pub struct ScanOpts {
    pub limit_files: Option<usize>,
    pub force_rescan: bool,
}

pub struct ScanReport {
    pub provider: &'static str,
    pub files_seen: usize,
    pub files_changed: usize,
    pub rows_inserted: usize,
    pub bytes_read: u64,
}
```

Existing `scanner.rs` becomes `providers/claude.rs` (implements `Provider`); the public `scan(...)` fn in `core::scanner` keeps its signature and just delegates to the Claude impl for one release, then becomes `providers::scan_all(db, &[Box::new(Claude), Box::new(Codex), …])` driven by a registry. Pricing stays where it is; `pricing::cost_for(provider, model, tokens)` is the only API change there.

Layout:
```
crates/token-dashboard-core/src/providers/
  mod.rs        // trait, registry, ScanOpts/Report, helpers
  claude.rs     // moved from scanner.rs
  codex.rs      // new
  ollama.rs     // new (proxy log reader)
```

Keep `scanner.rs` as a thin re-export for one release cycle to avoid churning every `use` site. Delete in the release after.

---

## 5. API surface

Additive only.

- `GET /api/overview?provider=claude|codex|ollama|all` — default `all`, falls back to `claude` if only Claude data exists (no UI surprise).
- `GET /api/providers` — list of `{id, label, enabled, has_data, last_scan_at}`. Drives the filter chip row in the topbar.
- `POST /api/providers/{id}/enable` `{enabled: bool}` — soft toggle (suppresses from queries; data stays on disk).
- Existing endpoints (`/api/projects`, `/api/models`, `/api/sessions`, `/api/limits`, `/api/budget`, `/api/phase_split`) gain an optional `?provider=` query. Server defaults to `all` so old clients keep working.
- `/api/limits` stays Claude-only — OpenAI rate-limit headers can be added in a follow-up; Ollama has none.

SSE bus: existing `data_updated` event already triggers a frontend refresh, no schema change needed. Emit one event per provider scan with `{provider}` in the payload.

---

## 6. Frontend changes

Minimum-viable footprint:

1. **Provider `<select>`** in `a-topbar`, placed next to the date-range control (top-right). Options: `All providers · Claude · Codex · Ollama`. Persist selection in `preferences` table key `ui.provider_filter`. Matches existing styling (`.a-strip-right` group). Hidden when only one provider has data (no point showing a one-option dropdown). The selection is global — every view re-fetches with `?provider=` when it changes (same pattern the date range already uses).
2. **`KpiRow`** (`overview.jsx`) — when `provider=all`, swap "Tokens (input/output)" to a stacked-by-provider mini bar. Otherwise unchanged.
3. **`ModelsCard`** — already a table; add a "Provider" column, sorted ascending so Claude rows stay top-of-list for existing users.
4. **`ProjectsTable`** — project rows can mix providers (same cwd used by multiple CLIs). Add a small provider-icon strip in the project name cell.
5. **`PhaseSplitCard`** / **`LimitsCard`** — hide when `provider != claude` (Claude-specific concepts).

Theme tokens: add `--provider-claude`, `--provider-codex`, `--provider-ollama` to each theme block. Use existing `--accent`/`--accent-2` as starting palette so new themes don't break.

---

## 7. Migration / rollout

Three releases:

- **v4.1** — schema migration (`provider` column, default `'claude'`), trait refactor, `providers::claude` ships. No behaviour change. Hidden `?provider=` query works. Frontend untouched.
- **v4.2** — Codex provider on by default if `~/.codex/sessions/` exists. Provider chips appear in topbar only when ≥2 providers have data. Models card gains Provider column.
- **v4.3** — Ollama proxy shim (separate binary `td-ollama-proxy`). Off by default; settings page exposes "Enable Ollama tracking" with the proxy URL to paste into the user's client config.

Backwards-compat guarantee: every existing route returns the same JSON shape when called without `?provider=` and only Claude data is present.

---

## 8. Risks & open questions

- **Pricing data freshness.** OpenAI prices change; we'd have to ship pricing updates. Mitigation: same `TOKEN_DASHBOARD_PRICING` override env var already exists; ship updates inside point releases.
- **Codex session-id stability.** Older Codex versions don't write a stable session id — may need to derive one from filename. Need to verify against current Codex CLI.
- **Ollama "cost".** Showing `$0.00` everywhere is boring; the "would-have-cost" comparison is the actual feature. Picking a default comparison model (haiku-4-5? sonnet-4-6?) is a UX decision deferred to v4.3 spec.
- **Tool calls.** Codex emits its tool/function call events differently per model family. v4.2 starts with "shell"/"apply_patch" only; full mapping deferred.
- **Streaming-snapshot dedup** is Claude-specific. The `messages_ai` / `messages_au` triggers stay as-is; Codex/Ollama just don't generate snapshot duplicates.

---

## 9. Test plan

- Unit: Codex/Ollama line parsers with golden fixtures under `crates/token-dashboard-core/tests/fixtures/{codex,ollama}/`.
- Integration: `scan_all` against a temp DB with one Claude + one Codex + one Ollama fixture file, assert per-provider rowcount and that `(provider, session_id, message_id)` is unique.
- API: `GET /api/overview?provider=codex` returns only codex rows; without query returns union.
- Frontend: a Cypress-style smoke that toggles chips and asserts table rowcount changes.

---

## 10. Effort estimate

- Schema + trait refactor (v4.1): ~1 day.
- Codex provider + tests + pricing table extension (v4.2): ~2 days backend, ~1 day frontend.
- Ollama proxy shim (v4.3): ~2 days (new binary, settings UI, docs).

Total: ~1 working week if scoped tight; ~2 weeks with polish + cross-platform QA.
