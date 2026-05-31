---
name: Token Dashboard
description: Local, dense, multi-theme dashboard for inspecting Claude Code token cost.
colors:
  ink-slate: "#0A0E14"
  carbon-panel: "#0F1419"
  carbon-panel-2: "#131922"
  iron-border: "#1F2630"
  iron-border-2: "#283040"
  bone-text: "#E6EDF3"
  gull-gray: "#8B98A6"
  gull-gray-2: "#5A6573"
  console-blue: "#4A9EFF"
  signal-violet: "#7C5CFF"
  receipt-green: "#3FB68B"
  caution-amber: "#E8A23B"
  fault-red: "#E5484D"
typography:
  headline:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
    fontFeature: "'cv11', 'ss01'"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  metric:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "clamp(28px, 4vw, 36px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.04em"
  label:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  2xl: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-default:
    backgroundColor: "{colors.carbon-panel-2}"
    textColor: "{colors.bone-text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    typography: "{typography.body}"
  button-default-hover:
    backgroundColor: "{colors.carbon-panel-2}"
    textColor: "{colors.bone-text}"
    rounded: "{rounded.md}"
  button-primary:
    backgroundColor: "{colors.console-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.gull-gray}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    typography: "{typography.body}"
  card:
    backgroundColor: "{colors.carbon-panel}"
    rounded: "{rounded.xl}"
    padding: "18px"
  kpi:
    backgroundColor: "{colors.carbon-panel}"
    rounded: "{rounded.xl}"
    padding: "16px"
    typography: "{typography.metric}"
  pill:
    backgroundColor: "{colors.carbon-panel-2}"
    textColor: "{colors.gull-gray}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    typography: "{typography.mono}"
  badge-opus:
    backgroundColor: "rgba(124,92,255,0.08)"
    textColor: "{colors.signal-violet}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
    typography: "{typography.mono}"
  badge-sonnet:
    backgroundColor: "rgba(74,158,255,0.08)"
    textColor: "{colors.console-blue}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
    typography: "{typography.mono}"
  badge-haiku:
    backgroundColor: "rgba(63,182,139,0.08)"
    textColor: "{colors.receipt-green}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
    typography: "{typography.mono}"
  range-tab-active:
    backgroundColor: "{colors.ink-slate}"
    textColor: "{colors.bone-text}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
    typography: "{typography.mono}"
  tip:
    backgroundColor: "{colors.carbon-panel-2}"
    rounded: "{rounded.lg}"
    padding: "14px"
  modal:
    backgroundColor: "{colors.carbon-panel}"
    rounded: "{rounded.2xl}"
    padding: "24px"
---

# Design System: Token Dashboard

## 1. Overview

**Creative North Star: "The Quiet Telemetry Bench"**

A personal workbench with instruments laid out — readouts, gauges, a small ledger — sitting calmly on the desk. The user glances down, reads what they need, looks back up. Multi-theme like a real cockpit panel (a `bench` dark default, plus 18 named finishes spanning dark, light, and three animated "special" identities), but the *layout, density, and rules* never shift. Themes are instrument finishes, not redesigns.

The system rejects the SaaS-dashboard impulse to dramatize. No giant centered "TOTAL TOKENS" with gradient halo. No animated mesh background pretending the data is alive. No glassmorphism stacked on a hero. Cost is reported as a fact in tabular-nums monospace. The user is trusted to read.

It also rejects the corporate-observability impulse to feel like a Datadog console. The voice is a knowledgeable peer showing you their own dashboard, not an enterprise vendor pitching one. The brand dot glows softly. The hover states are quick. Color is deployed sparingly and on purpose.

**Key Characteristics:**
- Density-first, instrument-grade layout. 13px body, dense rows, mono numbers, tabular-nums everywhere costs appear.
- Flat-by-default surfaces. 1px borders carry the structure; shadows are reserved for floating layers (modal, dropdown).
- Nineteen-theme color system on a single shared scale: 10 dark, 6 light, 3 animated "special" finishes. Same tokens, swapped values; layout never changes.
- Uppercase micro-labels (10px, 0.08em letter-spacing) for KPI captions and table headers — the instrument-panel signal.
- Status colors (`good`/`warn`/`bad`) used quietly. Not as decoration.
- A Live tab (vault-explorer subsystem ported from Praetorium) reuses the same token contract — same surfaces, same Console Blue accent, same type pairing — applied to a terminal-readout surface with console / cockpit / explorer views.

## 2. Colors

A muted, high-contrast slate-and-blue base with a small set of semantic accents. The palette is intentionally narrow per theme — one primary accent, one secondary, three semantic — because the dashboard's job is reading numbers, not painting moods.

The frontmatter holds the **`bench` dark theme (the default)**. The same token names exist in all eighteen other themes; values shift, semantics don't. The `[Themes]` block below catalogues the alternates so the spec covers every finish.

### Primary
- **Console Blue** (#4A9EFF / `oklch(70% 0.15 250)`): Brand accent. The glowing brand dot, link color, primary button, sonnet model badge, active-tab indicator. Used on ≤10% of any given screen.

### Secondary
- **Signal Violet** (#7C5CFF / `oklch(60% 0.22 280)`): Reserved for the Opus model badge and the second chart-series slot. Permitted on identity badges (model chips) and chart series only — never on layout chrome (nav, borders, dividers, topbar) or interactive affordances (links, buttons, active states). Held to ≤5% of any screen. Its purpose is to mark *Opus* in lists and charts so the eye finds it.

### Tertiary
- **Receipt Green** (#3FB68B): Cost values in KPIs ("$4.21 today"), positive deltas ("up 12%"), Haiku model badge. Cost color is positive-coded because spending is a fact reported, not a warning.
- **Caution Amber** (#E8A23B): Warnings in the tips engine, third chart-series slot. Never used on layout chrome or interactive affordances — semantic warning text and chart series only.
- **Fault Red** (#E5484D): Errors and negative deltas only. Never decoration.

### Neutral
- **Ink Slate** (#0A0E14): Page background. Deeper than the panels so cards float by contrast, not by shadow.
- **Carbon Panel** (#0F1419): Card and KPI background.
- **Carbon Panel 2** (#131922): Hover state for table rows and ghost buttons; pill background; badge background tint.
- **Iron Border** (#1F2630): Default 1px border for cards, table rows, buttons.
- **Iron Border 2** (#283040): Heavier border for floating layers (modal, dropdown), active states.
- **Bone Text** (#E6EDF3): Primary text, KPI values, table cell content.
- **Gull Gray** (#8B98A6): Muted text — captions, table headers, tip body, label sub-text.
- **Gull Gray 2** (#5A6573): The quietest tier — placeholder, disabled, deep-muted secondary text.

### Themes

The dashboard ships **nineteen themes** on the same token scale, registered in `frontend/src/theme.js` and grouped into three modes in Settings → Theme: **Dark**, **Light**, and **Special**. The user picks one. Each is a complete identity, not a skin variant — forge has its own personality (warm, forge-fire) just as forest does (mossy, evergreen). The token *contract* (surface roles, accent budget, type pairing, flat elevation) is identical across all nineteen; only the `--bg` / `--panel` / `--accent` / `--bone` values change.

The table lists each theme's identity anchors — page background, panel, accent, and primary text — pulled from the swatch registry. These four colors define the finish; the full thirteen-token block per theme lives in `frontend/styles.css` (`.dir-a-root.theme-X { … }`).

**Dark (10) — `bench` is the default (no theme class).**

| Theme | `--bg` | `--panel` | `--accent` | `--bone` |
|---|---|---|---|---|
| bench (default) | #0A0E14 | #0F1419 | #4A9EFF | #E6EDF3 |
| dim | #0F1318 | #13181F | #4A9EFF | #C7CFD8 |
| forge | #14100C | #1A140E | #ED7E3F | #F5E8D8 |
| forest | #0C1410 | #0F1A14 | #5CBC7A | #E0F0E5 |
| dusk | #0F0D1A | #171326 | #A77FF0 | #ECE6FF |
| ocean | #07131A | #0B1B26 | #36C2C2 | #DCEFF7 |
| matrix | #000805 | #031410 | #1FE26F | #B8FFD0 |
| rose | #1A0A12 | #22101A | #F4598F | #FFE2EC |
| breaking bad (bb-dark) | #0A0E08 | #12140F | #DCC81A | #F0E8B8 |
| cyberpunk (cyber-dark) | #0A0710 | #1A1B26 | #BB22BD | #D1C5C0 |

**Light (6)**

| Theme | `--bg` | `--panel` | `--accent` | `--bone` |
|---|---|---|---|---|
| paper | #F7F9FC | #FFFFFF | #2F7FDB | #1A2330 |
| linen | #F5EFE4 | #FCF7EC | #A85528 | #3A2E1C |
| mint | #ECF6EF | #F8FCF9 | #0F9669 | #1B3A2A |
| lilac | #F2EEF8 | #FAF7FF | #7449F0 | #2D1F47 |
| breaking bad (bb-light) | #F4EFC8 | #FAF7DD | #1F5C36 | #12140F |
| cyberpunk (cyber-light) | #F2EAE5 | #FBF5F2 | #BE2BBE | #272932 |

**Special (3) — animated ambient canvas + custom display fonts, gated on `prefers-reduced-motion` / the "reduce motion" toggle.**

| Theme | `--bg` | `--panel` | `--accent` | `--bone` |
|---|---|---|---|---|
| terminal | #020806 | #0a3a26 | #36ff7a | #b7ffce |
| cockpit | #04080f | #0e3a5c | #00d4ff | #ffaa00 |
| grimdark | #0a0807 | #3a261c | #c8a24a | #b8231a |

The three **special** themes (`terminal`, `cockpit`, `grimdark`) are the only ones that layer extra fonts (VT323, Orbitron, Cinzel/Cormorant) and an animated ambient canvas on top of the token contract. They carry the same density and rules — the animation is chrome, not content motion, and it freezes under reduced-motion. Per-theme chart series palettes shift alongside the tokens.

### Named Rules

**The One Voice Rule.** The primary accent (Console Blue in dark; the per-theme equivalent everywhere else) is used on ≤10% of any given screen — the brand dot, link color, primary button, the active nav indicator, one chart series. Its rarity is the point. If two things are accent-colored, ask which one is more important and demote the other.

**The Quiet-Status Rule.** `good`/`warn`/`bad` colors are signals, not decoration. A KPI value tinted `good` because it represents cost is fine — that is a *consistent semantic*, not an alarm. A row tinted `bad` because the user "spent a lot today" is forbidden — cost is reported as fact, not panic.

**The No-Gradient Rule.** Decorative gradients are forbidden. The single permitted gradient in the system is the topbar's vertical fade (`linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%)`) which exists to soften the edge between sticky chrome and content. No gradient text. No mesh backgrounds. No "AI sparkle" effects.

## 3. Typography

**Display Font:** None — no separate display *family*. The largest tier is the mono metric, a fluid `clamp(28px, 4vw, 36px)` (KPI tiles: `clamp(26px, 18cqi, 36px)` via container query) that scales up under denser layouts (compact 36px, spacious 56px) and the special themes. Large but *dense* — the system rejects the single dramatized hero number, not large numerals (see the No-Hero-Metric Rule).
**Body Font:** Inter (with `system-ui`, `-apple-system`, `Segoe UI` fallbacks). OpenType features `cv11` and `ss01` enabled for cleaner numerals and a-glyphs.
**Mono Font:** JetBrains Mono (with `ui-monospace`, `SFMono-Regular`, `Consolas` fallbacks).

**Character:** Inter at 13px is the body voice — neutral, readable, slightly humanist. JetBrains Mono carries every number and identifier. The mono-for-numbers contract is rigid: any number that represents a quantity (tokens, cost, percentage, count, duration) renders in mono with `font-variant-numeric: tabular-nums` so columns of figures align cleanly. Sans renders prose, labels, and navigation.

### Hierarchy

- **Headline** (Inter 600, 16px, line-height 1.3, letter-spacing -0.01em): Card titles (`.card h2`). The largest sans tier in the system.
- **Title** (Inter 600, 13px): Sub-section headings inside cards (`.card h3`). Same size as body, distinguished by weight.
- **Body** (Inter 400, 13px, line-height 1.55): Paragraphs, table cells, tip body text, muted captions.
- **Mono** (JetBrains Mono 500, 12px): Pills, badges, range-tab values, table mono cells, code in glossary terms.
- **Metric** (JetBrains Mono 400, fluid `clamp(28px, 4vw, 36px)`, line-height 1, letter-spacing -0.04em, tabular-nums): KPI values, the visual anchor of the Overview tab. KPI tiles size via container query (`clamp(26px, 18cqi, 36px)`); density modes scale it to 36px (compact) / 56px (spacious); the activity-map headline runs ~40px; special themes (terminal 56px) push further for their pixel/display fonts. It is the largest tier in the system, by design.
- **Label** (Inter 600, 10px, letter-spacing 0.08em, **uppercase**): KPI captions, table column headers, tip-type headers, glossary `<dt>`. The instrument-panel signal — small, spaced, deliberate.

### Named Rules

**The Mono-for-Numbers Rule.** Any number representing a quantity renders in JetBrains Mono with `font-variant-numeric: tabular-nums`. Currency, token counts, percentages, durations, deltas, byte sizes, ranks. Identifiers (project slugs, model names, file paths) also go in mono. Prose nouns and verbs stay in Inter. If you find yourself rendering a numeric column in sans, stop.

**The Uppercase-Micro-Label Rule.** Labels at the 10px tier are uppercase with 0.08em letter-spacing. This is the instrument-panel cue. Do not use uppercase for body content. Do not raise the size above 11px while keeping uppercase — it crosses into shouting.

**The No-Hero-Metric Rule.** The prohibition is the *SaaS hero-metric template*, not large numerals: never a single giant centered number with a gradient halo and three small supporting stats. Metrics are deliberately large (fluid 28–36px at default, 56px in spacious density and special themes) — but they appear as a **dense row of equals** (up to 7 KPIs across), so the eye reads *across* a ledger rather than staring at one dramatized figure. Density adds whitespace and scale to the whole row, never promotes one number to a hero. The Live Cockpit's 48px focal readout fits this: it is the instrument's primary gauge among other readouts, not a marketing hero.

## 4. Elevation

The system is **flat by default**. Surfaces sit on the page background and are differentiated by 1px borders and a slightly lighter background (`carbon-panel` on `ink-slate`). No card shadows, no layered "elevation" hierarchy on at-rest content.

Shadows appear only on **floating layers** — surfaces that escape the document flow and need to read as "above the page." There are exactly three: the dropdown menu (theme switcher), the first-run modal, and the modal overlay. Hover states use background shifts and border-color changes, never shadow.

Depth in the resting layout is conveyed by border + background contrast, not by lift.

### Shadow Vocabulary

- **Dropdown shadow** (`box-shadow: 0 6px 24px rgba(0,0,0,0.4)`): Theme menu and any future popover. Soft, low, drops the panel a fingernail above the chrome.
- **Modal shadow** (`box-shadow: 0 20px 60px rgba(0,0,0,0.5)`): First-run modal and any future blocking dialog. Larger and deeper because the modal is a true scene change.
- **Brand-dot glow** (`box-shadow: 0 0 12px var(--accent)`): The 8×8 brand dot in the topbar. Functional ornament — the only "glow" in the system, and it's tiny.

### Named Rules

**The Flat-By-Default Rule.** At-rest content surfaces (cards, KPIs, tables, tips, drawers) carry no shadow. Border + background contrast does the work. If a card "feels lost," fix the border (`iron-border-2` instead of `iron-border`) or the spacing — do not add a shadow.

**The Floating-Layer Exception.** Shadows are reserved for surfaces that *float above* the document — modals and dropdown menus. If a new component does not literally float, it does not get a shadow.

**The One-Glow Rule.** Glow effects (large blur-radius rgba shadows on colored elements) are forbidden. No glowing buttons, no glowing badges, no halo effects on KPIs. The brand dot's freshness pulse (opacity animation, gated on `html[data-fresh]` for 30s after a scan lands) is the single permitted motion in the system — it carries state, not decoration. No idle ambient motion anywhere.

## 5. Components

### Buttons
- **Shape:** 6px radius (`rounded.md`). Rectangular-ish, not pilled.
- **Default:** `carbon-panel-2` background, `bone-text` color, `iron-border` 1px border, 6px×12px padding. Hover lifts the border to `iron-border-2`. The dashboard's everyday button.
- **Primary:** `console-blue` background, white text, no visible border (border matches background). Reserved for the single most important action on a view (e.g., "Refresh"). At most one primary per view.
- **Ghost:** Transparent background, `gull-gray` text. Used for secondary actions where presence should be implied, not asserted.
- **Hover / Focus:** 120ms transition on `background` and `border-color`. No transform, no shadow change.

### Pills (status & filter chips in topbar)
- **Style:** `carbon-panel-2` background, 1px `iron-border` border, 6px radius, 4px×10px padding, mono font 12px, `gull-gray` text.
- **Interactive variant** (`pill-btn`): text bumps to `bone-text`, hover background shifts to `iron-border`. Used for the refresh button and theme menu trigger.

### Cards / Containers
- **Corner Style:** 10px radius (`rounded.xl`).
- **Background:** `carbon-panel`, sitting on the `ink-slate` page background.
- **Shadow Strategy:** None. See Elevation §4.
- **Border:** 1px `iron-border`. The drawer (drilldown panel) uses `iron-border-2` to mark it as a deeper context.
- **Internal Padding:** 18px standard. KPI cards drop to 16px because their content is shorter.

### KPI Tiles
- **Layout:** Caption (label tier, uppercase) at top, value (metric tier, mono 22px) below, optional delta (mono 12px) and sub-line (gull-gray 11px).
- **Cost variant:** value tinted `receipt-green` (`good`). The only at-rest semantic color in the system besides badges.
- **Density:** Up to 7 KPIs in a row at desktop, collapsing to 4 then 2 at narrower breakpoints.

### Badges (model identifiers)
- **Shape:** 4px radius (`rounded.sm`), 2px×7px padding, mono 11px.
- **Tinted variants:**
  - **Opus** — `signal-violet` text on a `rgba(124,92,255,0.08)` background with a 30%-opacity violet border.
  - **Sonnet** — `console-blue` on `rgba(74,158,255,0.08)`.
  - **Haiku** — `receipt-green` on `rgba(63,182,139,0.08)`.
- The colored-tint-border-text triple is the only place in the system where a colored background and a colored text and a colored border appear together. It is reserved for model identification.

### Tables
- **Style:** Full-width, `border-collapse: collapse`. 9px×12px cell padding. Bottom-only borders (`iron-border`). No vertical lines.
- **Header:** Label tier — uppercase 10px gull-gray, 0.06em letter-spacing.
- **Numeric cells:** `td.num` — mono, right-aligned, tabular-nums.
- **Identifier cells:** `td.mono` — mono, gull-gray, left-aligned.
- **Hover:** Row background shifts to `carbon-panel-2` over 100ms.

### Time-range tabs
- **Container:** `carbon-panel-2` background, 1px border, 6px radius, 2px inner padding (segmented-control style).
- **Inactive tab:** Transparent background, gull-gray mono text, 4px×10px.
- **Active tab:** `ink-slate` background (a step *darker* than the container — inverted from typical "active is brighter"), `bone-text`. The darker-active treatment reads as "punched in."

### Modal (first-run)
- **Backdrop:** Fixed full-screen `rgba(10,14,20,0.85)` with `backdrop-filter: blur(8px)`.
- **Surface:** `carbon-panel`, 12px radius, 24px padding, max-width 460px.
- **Shadow:** Modal shadow (see Elevation §4).

### Tips (rule-based suggestions)
- **Style:** `carbon-panel-2` background, 1px `iron-border` border, 8px radius, 14px padding, 10px vertical margin between tips.
- **Head:** Bold 13px title; body in muted `gull-gray`.
- **Lists:** 20px left padding, 2px row gap, gull-gray text.

### Inputs / Selects
- **Style:** Same chrome as default button (`carbon-panel-2` bg, `iron-border` border, 6px radius, 6px×12px padding, 13px sans).
- **Hover:** Border shifts to `iron-border-2`.
- **Focus:** Native focus ring (browser default). The dashboard does not yet define a custom focus style; if added, use a 2px outline in `console-blue` with 2px offset, never a glow.

### Drawer (prompt drilldown)
- **Behavior:** Inline expansion below a clicked row, not a sliding panel.
- **Style:** Card variant — same shape, but `iron-border-2` border to mark deeper context. Top margin 16px from the trigger row.
- **Pre block:** `ink-slate` background, 6px radius, 1px `iron-border`, mono 12px, `pre-wrap` + `word-break`, max-height 400px scroll.

### Topbar
- **Style:** Sticky top, `linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%)` background, 1px bottom border, `backdrop-filter: saturate(180%) blur(8px)`. The single permitted glassmorphism in the system — a thin chrome layer over scrolling content.
- **Brand:** Inter 600, 14px, `-0.01em` tracking, with the 8×8 `console-blue` square (2px radius). The dot pulses for 30s after a scan lands (gated on `html[data-fresh]`) — the only motion in the system tied to state. Flat at rest.
- **Nav:** Capitalized 13px medium, 5px×10px padding per link, 6px radius, `gull-gray` at rest, `bone-text` on hover/active with `carbon-panel-2` background. Active link uses the same treatment as hover.

### Glossary (Settings tab)
- **Pattern:** Native `<details>` / `<summary>`, custom triangle marker (`▸` rotates 90° on open).
- **Layout:** `<dl>` with 160px `<dt>` column, terms uppercase label-tier, definitions in body tier with inline `<code>` chips on `carbon-panel-2`.

### Live tab (vault-explorer subsystem)

A self-contained subsystem ported from Praetorium (JS in `frontend/src/live/`, root class `.pr-root`; its stylesheet is served as `frontend/live.css` — the canonical Live CSS, wired into `index.html`), embedded as a tab and also openable as a Tauri pop-out window. It is **not a second design system**: its foundation block re-declares the same tokens (`#0A0E14` ink-slate page, carbon panels, `#4A9EFF` Console Blue accent held to ≤10%, Inter + JetBrains Mono, flat-by-default, 120ms `color`/`background` motion). The north star is the same instrument bench, framed as "The Terminal Status Readout": terminal-prompt chrome, mono everywhere, sharp panels, a dot-grid background and a single animated scan-line.

- **Two-voice contract (stricter here):** Inter carries prose and body only; JetBrains Mono carries the brand prompt, nav, card titles, and every number / identifier. The Live surface leans more mono than the main dashboard.
- **Secondary nav rail:** a slim icon rail (`.a-live-subrail`) that expands on hover, reusing the main dashboard's `.a-rail` / `.a-rail-link` / `.a-rail-ico` / `.a-rail-label` classes so it stays pixel-consistent with the primary nav.
- **Three views** (switched by the rail; "settings" was removed — theme/glass/vault live in the main Settings tab):
  - **Console** — the agent run log: a terminal-style readout streaming `claude` CLI events with a left rail of runs.
  - **Cockpit** — a radial constellation HUD of sessions/agents. The one place a large display metric appears (see the No-Hero-Type exception in §3).
  - **Explorer** — the vault file explorer: a `files` tree, a `map` (links graph), and a `sessions` list.
- **Pop-out:** the rail's pop-out button invokes the `open_live_window` Tauri command to detach Live into its own window. No-op in plain web/dev (no Tauri), so the button degrades gracefully.

### Empty / Loading / Error states

The principle: **panel positions never shift between states.** The card shell — border, panel bg, padding, dimensions — stays identical whether the card is full, empty, loading, or errored. The data inside changes; the architecture does not. No skeleton bars, no spinners, no ghost-UI outlines, no illustrations.

#### Empty
- **Card shell unchanged.** Same border, same `--panel`, same height (or natural height of empty content — no collapse).
- **Body:** one 11px Inter italic line in `--gull-2`, prefixed with the `›` accent glyph (see `.a-chart-empty`). Optional 10px uppercase label-tier state token below ("NO DATA", "NO MATCH", "FILTERED OUT"). The label tier is the instrument-panel signal of the system, so the state name belongs there.
- **First-launch variant:** same shell, plus a 11px Inter regular sub-line in `--gull` naming the next action ("Run Claude Code to populate."). No illustration, no CTA button — the dashboard is a passive observer of `~/.claude/projects/`.
- **Tables:** render `<thead>` as normal, then a single `<tbody>` row spanning all columns at 80px height, centered label-tier text. The header row carries the structure; never hide it.

#### Loading
- **No skeleton loaders. No spinners. No shimmer.** The dashboard renders cached data immediately with no visual diff. The brand dot is the loading signal — flat at rest, subtle pulse for 30s after a scan lands (`html[data-fresh]`). Only motion tied to state in the system.
- **Cold load** (first paint, no cache): cards render with the empty-state shell. There is no loading-specific surface — empty and "loading from cold" look identical, which is correct because the user has no data to compare against.
- **Inline async** (user-triggered, e.g. `POST /api/limits/sync`): the trigger button replaces its label with `…` (single Unicode ellipsis, mono, `--gull`). Button width preserved with `min-width`. No spinner glyph, no progress bar.

#### Error
Two tiers — card-local and global.

- **Card-local.** Same shell. One 11px Inter line in `--bad` ("Couldn't load"), plus one 10px label-tier line in `--gull-2` naming the cause ("CONNECTION", "PARSE", "TIMEOUT", "STALE"). No retry button at this tier; the next automatic scan/poll is the retry path. If the card has a known-good cached frame, prefer rendering the cached frame and surfacing the error in the global banner instead.
- **Global banner.** Strip above the topbar, 32px tall, `--panel-2` bg, 1px `--bad` top+bottom border, mono 11px `--bone` body, 10px label-tier `--bad` prefix ("CONNECTION ›"), dismiss "×" on the right in `--gull-2`. No enter animation. Surfaces only for SSE-to-polling fallback (plan §R1) or when every data source is unreachable. Single banner at a time — newer errors replace older ones.
- **Validation** (settings forms): inline 11px Inter line in `--bad` below the field, 4px top margin. Field border switches to `--bad`. Both clear on next valid input. No icon.

#### Transition rules
- All state changes follow the existing 120ms `color` + `background` transition rule. Layout properties (`transform`, `width`, `height`, `margin`, `padding`) do not animate between states.
- A card moving from loading-cold → populated → empty → errored never changes dimensions. If the populated content is taller than the empty content, the card grows when it populates and stays at the larger height; it does not shrink back when re-emptied within the session. (Avoids the layout-jitter feel of dashboards that "breathe" on every poll.)

## 6. Do's and Don'ts

### Do:

- **Do** render every number that represents a quantity in JetBrains Mono with `font-variant-numeric: tabular-nums`. Currency, tokens, percentages, durations, ranks. Numbers in sans are wrong.
- **Do** use the 10px uppercase 0.08em-letter-spacing label for every KPI caption and table header. It is the instrument-panel signal of the system.
- **Do** use `receipt-green` for cost values and positive deltas — cost is a fact reported, not a warning.
- **Do** keep the primary accent (Console Blue, or the per-theme equivalent) at ≤10% of any screen. The brand dot, links, primary button, active nav, one chart series.
- **Do** use 1px borders + `carbon-panel` on `ink-slate` to differentiate cards. Border + background contrast does the work that shadows would do in lazier systems.
- **Do** keep the Opus/Sonnet/Haiku badge triple as the *only* place colored bg + colored border + colored text appear together. It is reserved for model identification.
- **Do** transition `color` and `background` over 120ms (100ms on table rows). Snappy, not gummy. Layout properties (transform, width, height) do not animate.
- **Do** treat the four themes as four complete identities sharing one token scale. Forge is not "dark with orange swapped in" — it is its own finish.

### Don't:

- **Don't** use neon gradients, glowing AI sparkles, purple-on-black "magical" treatment, gradient text, or animated mesh backgrounds. This is a dashboard for inspecting AI usage, not a product trying to look like AI made it. (PRODUCT.md anti-reference: *"Generic AI tool aesthetic"*).
- **Don't** build the SaaS hero-metric template — giant centered "TOTAL TOKENS THIS MONTH" with gradient halo and three small supporting stats. Information density beats theatrical singularity. (PRODUCT.md anti-reference: *"SaaS hero-metric template"*).
- **Don't** add glassmorphism to cards, KPIs, drawers, or modal surfaces. The topbar's `backdrop-filter` is the only acceptable use in the system. (PRODUCT.md anti-reference: *"Glassmorphism by default"*).
- **Don't** use emoji, confetti, gamified language ("you saved $X this week!"), or oversized red/green dollar figures. Cost is a fact. (PRODUCT.md anti-reference: *"Fintech gamification"*).
- **Don't** add shadows to at-rest content surfaces. Cards, KPIs, tips, drawers are flat. Shadows are reserved for floating layers (modal, dropdown). (Flat-By-Default Rule, §4.)
- **Don't** use `border-left` or `border-right` greater than 1px as a colored side-stripe accent on cards, list items, or tips. Always rewrite with full borders or a tinted background.
- **Don't** build the single dramatized hero metric — one giant centered number with a gradient halo and a few supporting stats. Large mono numerals are fine, and intended; a *dense row of equal KPIs* is the form. One number promoted above its row is the anti-pattern.
- **Don't** use uppercase on anything other than the 10px label tier. Uppercased body or headings cross into shouting.
- **Don't** apply `good`/`bad` color tints to rows or backgrounds based on cost magnitude. Cost is reported, not judged. The user decides what is high.
- **Don't** introduce a fifth theme without owning it as a complete identity (named, with its own personality and palette ramp). Random color skins erode the system.
- **Don't** use `#000` or `#fff` directly. Tinted neutrals only — use the existing tokens.
