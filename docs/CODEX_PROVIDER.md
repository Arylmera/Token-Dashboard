# Codex Provider — Ingest Spec

Field map and state-machine notes for `crates/token-dashboard-core/src/providers/codex.rs`.

Companion to [`docs/MULTI_PROVIDER_PLAN.md`](MULTI_PROVIDER_PLAN.md). This document is the contract between OpenAI Codex CLI's on-disk rollout format and the shared `messages` / `tool_calls` / `files` tables.

---

## 1. On-disk layout

| | Claude Code | Codex CLI |
|---|---|---|
| Root | `~/.claude/projects/` | `~/.codex/sessions/` |
| Path | `<slug>/<sessionId>.jsonl` | `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |
| Project key | folder slug | `payload.cwd` from `session_meta` / `turn_context` |
| Session id | file stem | `session_meta.payload.id` |
| Env override | `CLAUDE_PROJECTS_DIR` | `CODEX_SESSIONS_DIR` |

`payload.cwd` can change mid-file via `turn_context`; the parser updates `state.cwd` and re-derives `project_slug` on each `turn_context` event.

## 2. Record shape

Every Codex line is `{timestamp, type, payload}`. Four top-level `type`s observed:

- `session_meta` — line 1; carries `id`, `cwd`, `cli_version`, `model_provider`, `git.{commit_hash, branch, repository_url}`, full system prompt.
- `turn_context` — per turn; carries `cwd`, `model`, `sandbox_policy`, `approval_policy`. **This is where the model id lives** — Claude puts it on every message, Codex puts it once per turn.
- `event_msg` — semantic events with `payload.type`:
  - `task_started` — turn boundary; carries `turn_id`, `model_context_window`.
  - `user_message` — user-facing prompt; carries `message`, `turn_id`. Canonical user record (the `response_item` user blocks include system/developer noise we skip).
  - `agent_message` — assistant's final message for the turn; carries `message`, `phase`.
  - `token_count` — usage snapshot, includes `last_token_usage` and `total_token_usage`. Also carries `rate_limits` (feeds `/api/limits` without an external call).
  - `task_complete` — turn close; `duration_ms`, `last_agent_message`.
  - `error` — surfaces API/tool errors.
- `response_item` — raw API event with `payload.type`:
  - `message` (role `user`/`assistant`/`developer`) — we ignore these in favour of `event_msg.{user,agent}_message`; the response_item versions duplicate the system prompt and tool-result text.
  - `reasoning` — encrypted, opaque; only the token count matters and that arrives via `token_count.last_token_usage.reasoning_output_tokens`.
  - `function_call` — tool invocation; `name`, `call_id`, `arguments` (JSON string).
  - `function_call_output` — tool result; `call_id`, `output` (JSON string).

## 3. Field map → `messages`

One `messages` row per `event_msg.user_message` (type `user`) and one per `event_msg.agent_message` (type `assistant`).

| `messages` column | Codex source | Notes |
|---|---|---|
| `uuid` | `"cdx-{session_id}-{line_no}"` synthesized | Stable across rescans (line order is stable). |
| `parent_uuid` | uuid of the user message in the same `turn_id` | NULL for the user row itself. |
| `session_id` | `session_meta.payload.id` | Read once at file head. |
| `project_slug` | `slug_from_cwd(cwd)` | `C:\Users\g\proj` → `C--Users-g-proj`. Matches Claude's existing folder-name slugging. |
| `cwd` | `turn_context.cwd` or `session_meta.cwd` | Updated on each `turn_context`. |
| `git_branch` | `session_meta.payload.git.branch` | |
| `cc_version` | `session_meta.payload.cli_version` | Reused for "client version" across providers. |
| `entrypoint` | NULL | Codex has no analogue. |
| `type` | `"user"` \| `"assistant"` | |
| `is_sidechain` | `0` | Codex has no subagent concept. |
| `agent_id` | NULL | Same reason. |
| `timestamp` | record-level `timestamp` | RFC3339, already compatible. |
| `model` | `state.current_model` from latest `turn_context` | NULL until the first `turn_context` is observed. |
| `stop_reason` | NULL | Could derive from `task_complete` but not surfaced today. |
| `prompt_id` | NULL | |
| `message_id` | NULL | Codex has no streaming-snapshot dedup, so leaving NULL bypasses [`evict_prior_snapshots`](../crates/token-dashboard-core/src/scanner.rs). |
| `input_tokens` | `token_count.info.last_token_usage.input_tokens` | Attached to the assistant row of the turn. |
| `output_tokens` | `output_tokens + reasoning_output_tokens` | Reasoning tokens billed at output rate on `o`-family / `gpt-5-codex`; folded for v1. |
| `cache_read_tokens` | `cached_input_tokens` | Cache-hit input tokens; Codex doesn't distinguish creation. |
| `cache_create_5m_tokens` | `0` | Codex has no cache-write reporting. |
| `cache_create_1h_tokens` | `0` | |
| `prompt_text` | `event_msg.user_message.message` | User rows only. |
| `prompt_chars` | `chars().count()` of above | User rows only. |
| `tool_calls_json` | NULL | Tool summary is reconstructed from `tool_calls` rows. |
| `provider` | `'codex'` | Hard-coded in the INSERT. |

## 4. Field map → `tool_calls`

Two rows per tool invocation: one for the call (`tool_name = name`), one for the result (`tool_name = "_tool_result"`). Matches Claude's pattern.

| `tool_calls` column | Codex source |
|---|---|
| `message_uuid` | uuid of the most-recent assistant message in the turn (or, if none yet, the user message) |
| `session_id` | from session state |
| `project_slug` | from session state |
| `tool_name` | `response_item.payload.name` for calls; `"_tool_result"` for outputs |
| `target` | parsed from `arguments` JSON (see § 5) |
| `use_id` | `payload.call_id` |
| `result_tokens` | `output.chars().count() / 4` (mirrors Claude's `prompt_chars / 4` heuristic) |
| `is_error` | 1 if `output` JSON contains `"success":false` or `"error"`; else 0 |
| `timestamp` | record-level `timestamp` |
| `provider` | `'codex'` |

## 5. `target` extraction

`response_item.function_call.arguments` is a JSON string; parsed lazily, key chosen by tool name:

| Tool | Key |
|---|---|
| `shell`, `local_shell` | `command` (array → joined with spaces) |
| `apply_patch` | `input` |
| `read_file` | `path` |
| anything else | NULL |

Result truncated to 500 chars (Python-`s[:500]` semantics — `chars().take(500)`).

## 6. State machine

Per-file state carried across lines:

```text
SessionState {
  session_id        // from session_meta.id
  project_slug      // from slug_from_cwd(cwd)
  cwd               // updated on turn_context
  cli_version       // from session_meta.cli_version
  git_branch        // from session_meta.git.branch
  current_model     // updated on turn_context.model
  user_parents      // turn_id -> user_message uuid (for parent_uuid)
  last_usage        // turn_id -> {input, cached, output, reasoning}
  pending_calls     // call_id -> (tool_name, parent_message_uuid)
  last_assistant    // most-recent assistant uuid (for tool-call attribution)
  line_no           // monotonic, drives synthesized uuid
}
```

Event dispatch:

1. `session_meta` → populate session-wide fields.
2. `turn_context` → update `current_model` and `cwd`.
3. `event_msg.token_count` → stash usage in `last_usage[turn_id]`.
4. `event_msg.user_message` → INSERT message row (`type=user`); record uuid in `user_parents[turn_id]`; update `last_assistant = None` for this turn.
5. `event_msg.agent_message` → INSERT message row (`type=assistant`) with `parent_uuid = user_parents[turn_id]` and usage from `last_usage[turn_id]`; update `last_assistant`.
6. `response_item.function_call` → INSERT tool_calls row, parent = `last_assistant.unwrap_or(user_parents[turn_id])`; store `(name, parent)` in `pending_calls[call_id]`.
7. `response_item.function_call_output` → INSERT `_tool_result` row, parent looked up via `pending_calls[call_id]`.

Anything else is skipped silently.

## 7. Watermark behavior

Codex requires the state machine to see `session_meta` + `turn_context` history to correctly attribute model and parents. Mid-file resume would lose that context.

Decision: **scan from byte 0 on every modified file**. The `files (path, mtime, bytes_read)` watermark is still consulted as a fast-path skip (no scan if `mtime` + size match), but never used as a seek offset for Codex. `INSERT OR REPLACE` keyed on the synthesized `cdx-{session_id}-{line_no}` uuid keeps rescans idempotent.

Cost: a rescan re-parses the whole file. Acceptable for v1 — typical Codex sessions are O(MB), parsing is sub-second. Revisit if users hit pathological session sizes.

## 8. Schema impact

None. The `provider` column on `messages` / `tool_calls` / `files` already exists (added in [`db::migrate_add_provider`](../crates/token-dashboard-core/src/db.rs)). The Codex provider writes `provider='codex'` explicitly in its INSERTs; everything else is shared with Claude.

Provider-specific fields not yet surfaced:
- `reasoning_output_tokens` — folded into `output_tokens` for billing simplicity.
- `rate_limits` from `token_count` — not stored; could feed `/api/limits` later by being persisted in a small `provider_limits` table or in `plan`.

## 9. Pricing

Out of scope for this PR — the parser ingests raw counts; cost calculation happens in `pricing.rs` keyed on `(provider, model)`. Codex model ids observed: `gpt-5.2-codex`, `gpt-5-codex`. Pricing entries land in a follow-up.

## 10. Open questions

- Function-call schema across model families: GPT-5 codex emits `function_call`/`function_call_output`; older models may differ. Current parser handles the GPT-5 shape; others fall through silently.
- Tool-result `is_error` heuristic is string-matched; a structured field would be safer but Codex doesn't emit one consistently.
- Session id stability across CLI versions: spot-checked on `0.119.0-alpha.28`. Older versions may omit `session_meta.id`; parser falls back to filename UUID (last 36 chars of the stem).
- Reasoning-token pricing: when pricing lands, reasoning tokens may need a separate column or a pricing-time split — depends on whether OpenAI breaks them out in our pricing table.
