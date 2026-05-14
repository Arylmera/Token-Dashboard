# Launch assets

Draft copy for promoting Token Dashboard. Edit before posting — these are starting points, not final copy.

---

## 1. Show HN

**Title (≤80 chars):**

> Show HN: Token Dashboard – local desktop app to see where your Claude Code tokens go

**Body:**

Hi HN — I built Token Dashboard because Claude Code billed me far more than I expected and I had no idea which prompts were responsible.

It reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into:

- per-prompt cost (find the question that cost $4 in cache misses)
- daily / project / model breakdowns with stacked input / output / cache tokens
- subagent and skill attribution — see which skills earn their context budget
- a rule-based tips engine: low cache hit rate, repeated file reads, Opus-on-tiny-turns, retry storms
- SSE live refresh as new sessions land on disk

Stack: Rust + Tauri 2 shell, axum + SQLite for the data layer, React 18 frontend bundled with esbuild. Single ~5–10 MB installer per OS. No Python, no Node runtime, no Chromium.

100% local. No telemetry, no login, no account. The only optional network call is a button that reads your own Anthropic rate-limit headers using a key you paste in Settings.

Repo + Windows / macOS / Linux installers: https://github.com/Arylmera/Token-Dashboard

Happy to answer questions about the scanner (incremental, mtime + byte-offset), the streaming-snapshot dedup, or how the tips engine is wired.

---

## 2. r/ClaudeAI post

**Title:**

> I built a local dashboard to track where my Claude Code tokens actually go

**Body:**

After a month of "wait, how did I spend that much?" I wrote a desktop app that parses the JSONL transcripts in `~/.claude/projects/` and shows:

- the most expensive prompts you've ever sent, sorted
- per-project, per-model, per-day cost
- which skills + subagents are eating your context
- tips like "your cache hit rate dropped 40% on this project — here's why"

Fully offline. Rust + Tauri, ~7 MB installer. Free, MIT licensed.

Windows / macOS / Linux builds: https://github.com/Arylmera/Token-Dashboard

Roast the UI, request features, tell me what metric you wish existed.

---

## 3. X / Bluesky thread

**Post 1:**
Spent a month watching my Claude Code bill climb without knowing why.

So I built Token Dashboard — a local desktop app that turns your `~/.claude/projects/` JSONL into cost analytics, tool heatmaps, and a tips engine.

100% offline. ~7 MB. MIT.

🧵

**Post 2 (image: dashboard-wide.png):**
Per-prompt drill-down: find the single question that cost $4 in cache misses.

Stacked input / output / cache tokens per day. Daily budget burn line.

**Post 3 (image: tips view):**
Rule-based tips engine flags the expensive patterns *before* the next bill:

- cache hit rate falling
- Opus on tiny turns
- the same file read 12 times in one session
- retry storms

**Post 4:**
Stack: Rust + Tauri 2 shell, axum + SQLite, React 18 with esbuild. Single small installer, no Chromium, no Node runtime.

Repo + downloads: https://github.com/Arylmera/Token-Dashboard

---

## 4. GitHub repo polish

**Topics to add** (Settings → About → Topics):
`claude-code` `claude` `anthropic` `tauri` `rust` `token-tracking` `llm-observability` `cost-tracking` `developer-tools` `desktop-app` `analytics-dashboard`

**About blurb (≤350 chars):**
> Local desktop dashboard for Claude Code. Reads your JSONL transcripts and surfaces per-prompt cost, tool heatmaps, subagent attribution, cache analytics, and a rule-based tips engine. Rust + Tauri, fully offline, MIT.

**Pin in repo:**
- The latest release
- The expensive-prompts screenshot
- The tips view screenshot

---

## 5. Awesome-list PRs

Submit Token Dashboard to:

- `awesome-claude-code` (search GitHub for the canonical fork)
- `awesome-tauri`
- `awesome-rust` → Applications → Utilities
- `awesome-llmops` / `awesome-llm-observability`

PR template: one-line description matching the GitHub About blurb, link to release page, screenshot.

---

## 6. Launch checklist

- [ ] README hero screenshot is current (re-shoot if UI changed)
- [ ] Latest release has signed-looking changelog (no `wip:` / `fixup:` commits in the notes)
- [ ] All three installers download cleanly from the release page
- [ ] GitHub topics + About blurb set
- [ ] Pick launch day (Tue/Wed, post HN ~8am PT)
- [ ] Post Show HN
- [ ] Cross-post r/ClaudeAI ~2h later (different angle, link back to repo not HN)
- [ ] X thread same day with GIF
- [ ] Monitor issues — first 48h response time matters more than anything
