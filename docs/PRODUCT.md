# Product

## Users

The maintainer (personal use) and other curious Claude Code Pro/Max
users who want to understand where their tokens go. They already use
Claude Code daily, are technically literate, and are not paying
per-token but want a clear picture of what their session habits would
*cost* on the API and which prompts/tools/projects drive the bill.
They open the dashboard locally, glance at it for 30 seconds,
occasionally drill into an expensive prompt, and close it.

## Product Purpose

A local, zero-dependency desktop dashboard that turns Claude Code
session JSONL transcripts into legible cost analytics. Success looks
like: open the app, instantly see today's cost, the 30-day trend, and
the top three biggest token-usage items — without scrolling, without
configuration, without leaving the machine.

The dashboard exists because Claude Code session files are dense and
unstructured: nobody wants to grep JSONL to figure out which prompt
cost $4. This tool answers that question and a few related ones
(per-project breakdown, cache hit value, expensive-tool attribution)
with no telemetry, no signup, no internet.

## Brand Personality

**Technical and friendly.** Precise like a developer tool — exact
numbers, no rounding theater, dense information per pixel — but warm
enough to feel like a personal utility, not a corporate observability
suite. Voice: a knowledgeable peer showing you their own dashboard,
not an enterprise vendor pitching one.

Three-word version: *technical, friendly, honest*.

Emotional goal: quiet confidence. The user should feel informed, not
anxious. Cost is reported as a fact, not a warning.

## Anti-references

- **Generic AI tool aesthetic.** No neon gradients, no glowing "AI"
  sparkles, no purple-on-black "magical" treatment, no gradient text,
  no animated mesh backgrounds. This is a dashboard for inspecting AI
  usage, not a product trying to look like AI made it.
- **SaaS hero-metric template.** No giant centered "TOTAL TOKENS THIS
  MONTH" with gradient accent and three small supporting stats.
  Information density beats theatrical singularity.
- **Glassmorphism by default.** Native acrylic/vibrancy is opt-in via
  Settings → Glass; the rest of the dashboard stays flat.
- **Fintech gamification.** No emoji, no confetti, no "you saved $X
  this week!" pep talk. No oversized red/green dollar figures.
- **Corporate observability suite.** Not Datadog, not Grafana
  enterprise. Personal, not enterprise. Friendly, not clinical.

## Design Principles

1. **Honest density.** Show real numbers in real units. Tables and
   charts, not hero metrics. Trust the user to read.
2. **Local-first calm.** Everything runs on the user's machine; the
   interface should feel like that — no spinners pretending to call
   APIs, no skeleton loaders for instant data.
3. **Quiet semantics.** `good`/`warn`/`bad` exist but are used
   sparingly. Cost is information, not alarm.
4. **Drill, don't decorate.** Surface answers in summary, then let the
   user click into a prompt or project for the full story.
5. **Theme as personality, not novelty.** 14 themes are stable
   identities, not skins. Each carries the same density and rules;
   only the palette shifts.

## Distribution

The 4.0 line ships as platform-specific bundles via
`release-tauri.yml`:

- Windows: `.msi` (no NSIS — single installer format).
- macOS: `.dmg` for arm64 (Apple Silicon).
- Linux: `.deb` + `.AppImage` for x64.

Bundles are unsigned. Windows SmartScreen warns; macOS quarantine
needs an `xattr -d` to clear. Both are documented in the README.

A headless CLI (`cargo run -p token-dashboard-cli`) is the API-only
path — useful for development, scripting, or accessing the dashboard
from another device on the same network.

## Accessibility & Inclusion

No specific WCAG target beyond reasonable defaults. Maintain
sufficient contrast for body text (≥4.5:1) and chart axis labels in
every theme. Respect `prefers-reduced-motion` for any future motion.
No mandate for color-blind-safe palettes, but avoid red/green as the
*only* signal for status — pair with text or icon when state matters.
