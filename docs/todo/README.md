# Token Dashboard — Roadmap Plans

Implementation plans for queued features. Each plan is self-contained — pick one, follow it task-by-task. Tackle in any order; cross-references between plans are noted in their Self-Review sections.

## Plans

| # | Plan | One-line goal |
|---|------|---------------|
| 01 | [Burn-rate projection](./01-burn-rate-projection.md) | "Days left at current pace" on Overview |
| 02 | [Monthly budget alerts](./02-monthly-budget-alerts.md) | OS notifications at 50/80/100% of budget |
| 03 | [Cost-per-feature tagging](./03-cost-per-feature-tagging.md) | Tag sessions, aggregate ROI per tag |
| 04 | [Cache hit-rate sparkline](./04-cache-hit-rate-sparkline.md) | Daily cache hit rate trend on Overview |
| 05 | [Model efficiency leaderboard](./05-model-efficiency-leaderboard.md) | Cost-per-accepted-edit ranking by model |
| 06 | [Prompt verbosity detector](./06-prompt-verbosity-detector.md) | Find prompts with big input + tiny output |
| 07 | [Subagent ROI](./07-subagent-roi.md) | Delegation cost vs inline-equivalent |
| 08 | [Tool / MCP cost attribution](./08-tool-cost-attribution.md) | Which tools and MCP servers burn most |
| 09 | [Retry / loop detection](./09-retry-loop-detection.md) | Flag stuck-tool-call runs in sessions |
| 10 | [CSV / Parquet export](./10-export-csv-parquet.md) | Export tables for external BI |
| 11 | [Multi-machine sync](./11-multi-machine-sync.md) | Read-only aggregation across machines |
| 12 | [Week-over-week diff](./12-week-over-week-diff.md) | Side-by-side period comparison view |
| 13 | [Anomaly alerts](./13-anomaly-alerts.md) | 3σ session-cost outliers |
| 14 | [OS notifications](./14-os-notifications.md) | Native toasts for newly-crossed budget thresholds (finishes 02) |
| 15 | [Budget tab](./15-budget-tab.md) | New top-level page: threshold picker, budget editor, expanded burn-rate, per-project allocation, history |

## Conventions

Every plan follows the same shape (per `superpowers:writing-plans`):

- **File Structure** — files to create/modify before any task starts
- **Tasks** — TDD-flavored: failing test → confirm fail → minimal impl → confirm pass → commit
- **Self-Review Notes** — assumptions and known shortcuts at the bottom

Cargo verifications expected to pass at the end of each plan:

```bash
cargo test --workspace
cargo fmt --check
cargo clippy --all-targets --workspace -- -D warnings
```

Frontend smoke after any UI-touching plan:

```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

## Picking the next one

Suggested order if no other priority drives the call:

1. **04 (cache sparkline)** — small, sets up the shared `Sparkline` component used by 01.
2. **01 (burn rate)** — high signal, uses 04's sparkline.
3. **02 (budget alerts)** — wires the first OS-notification path; reused later.
4. **08 (tool/MCP cost)** — feeds 09 and 13.
5. **09 (loop detection)** — fast win once 08 lands.
6. **13 (anomalies)** — completes the "alerts" trio.
7. **05 (model efficiency)**, **07 (subagent ROI)** — both lean on pricing helpers.
8. **12 (diff view)** — pure analytics, no deps.
9. **03 (tagging)** — schema change, isolated.
10. **06 (verbosity)** — quick once 03 ships.
11. **10 (export)** — utility, last before sync.
12. **11 (multi-machine)** — biggest scope; do after the others to maximize the surface area being sync'd.
