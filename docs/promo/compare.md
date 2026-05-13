# Token Dashboard vs ccusage vs claude-usage — honest comparison

Three open-source tools read Claude Code's local JSONL transcripts and turn them into cost analytics. They overlap in purpose but optimize for very different workflows. I built Token Dashboard, so this writeup is biased; I've tried to keep the comparison fact-based and link to each project so you can verify.

## TL;DR

| | **Token Dashboard** | **ccusage** | **claude-usage** |
|---|---|---|---|
| Surface | Desktop app (Tauri 2) | CLI | Electron desktop app |
| Runtime | Rust + SQLite, ~7 MB | Node / Bun, npx-friendly | Node + Chromium, ~80 MB |
| Live refresh | SSE, automatic | Manual re-run | Manual reload |
| Per-prompt drill-down | Yes, joined to assistant turn | Limited | No |
| Tips engine | Yes, rule-based | No | No |
| Subagent / skill attribution | Yes | No | Partial |
| Cache-hit analytics | Yes | Yes | Yes |
| Project worktree-fold | Yes | No | No |
| Anthropic rate-limit sync | Opt-in, in-app | No | No |
| Best for | Browsing, exploring, fixing | Quick "what did I spend today" in a terminal | Lightweight overview without a CLI |

## When to pick each

**ccusage** — you live in the terminal, you want one command that prints today's spend, and you don't need historical drill-down. Fastest path to a number.

**claude-usage** — original inspiration for Token Dashboard. Clean, simple desktop overview. Pick this if you want a no-frills GUI and don't care about per-prompt forensics or tips.

**Token Dashboard** — you want to answer questions like *"which prompt cost $4?"*, *"which skill is eating my context?"*, *"why did my cache hit rate drop?"*. Closer to an observability dashboard than a spend counter.

## What Token Dashboard adds

- **Per-prompt cost** joined to the assistant turn that followed, so you can click an expensive question and see exactly what it triggered.
- **Tips engine**: low cache hit rate, repeated file reads, Opus on tiny turns, retry storms, oversized tool results.
- **Skills view**: invocation counts and per-call context cost from `~/.claude/skills/`, so you can see which skills earn their token budget.
- **Worktree-fold**: a parent repo doesn't fragment into N projects just because you keep multiple worktrees.
- **SSE live refresh** — new sessions appear without a reload.
- **Streaming-snapshot dedup** — Claude Code writes incremental snapshots of the same message; Token Dashboard dedups on `(session_id, message_id)` so you don't double-count.

## What Token Dashboard does *not* do

- No cloud sync, no team dashboards. One machine, one user.
- No CLI subcommand surface. There's a headless server (`token-dashboard` binary) but if you want a one-shot terminal report, ccusage is the better tool today.
- No alerts or notifications beyond the in-app tips. If you want to be paged when your daily budget breaches, it's a feature to file.

## Links

- Token Dashboard — https://github.com/Arylmera/Token-Dashboard
- ccusage — https://github.com/ryoppippi/ccusage
- claude-usage — https://github.com/phuryn/claude-usage

If anything here is out of date or wrong, open an issue or PR — I'd rather fix it than ship sloppy comparisons.
