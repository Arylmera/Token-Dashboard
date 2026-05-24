import React, { useState } from "react";
import { D } from "../data-store.js";
import { Label } from "../components/atoms.jsx";
import { copyToClipboard } from "../clipboard.js";

const TIP_CATEGORY_LABELS = {
  "cache": "Cache discipline",
  "repeat-file": "Repeated file reads",
  "repeat-bash": "Repeated bash commands",
  "right-size": "Right-sizing",
  "tool-bloat": "Tool-result bloat",
  "subagent-outlier": "Subagent outliers",
};

const TIP_MERGE_BODY = {
  "repeat-file": "These files were re-opened many times in the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.",
  "repeat-bash": "These bash commands ran many times in the past 7 days. Consider a watch flag or shell alias.",
};

// Last segment of a Claude Code project slug, used to label per-worktree rows
// when collapsing right-size tips into one card per parent project.
const slugTail = (slug) => {
  if (!slug) return "?";
  const wt = slug.indexOf("--claude-worktrees-");
  if (wt !== -1) return slug.slice(wt + "--claude-worktrees-".length);
  const tail = slug.split(/-+/).filter(Boolean).pop();
  return tail || slug;
};

const buildTipPrompt = (t, projectKey) => {
  const proj = projectKey === "__global__" ? "" : ` (project: ${projectKey})`;
  switch (t.category) {
    case "cache":
      return `In ${projectKey}, our Claude Code cache hit rate is below 40% over the last 7 days, meaning we keep rebuilding context instead of reusing it. Investigate the project for patterns that thrash the prompt cache: frequent /clear, redundant CLAUDE.md edits, large rotating system blocks, or sessions that load big files near the start. Propose concrete changes (CLAUDE.md restructuring, hook adjustments, session habits) that would lift the hit rate. Ask before editing files.`;
    case "right-size":
      if (t._merged) {
        const list = t.rows.map((r) => `  - ${r}`).join("\n");
        return `In ${projectKey}, ${t.count} short Opus turns (output < 500 tokens) ran across ${t.rows.length} worktrees in the past 7 days and would have been much cheaper on Sonnet:\n${list}\n\nAudit how Opus is invoked here — slash commands, agents, default model — and propose where to switch to Sonnet without hurting quality. List candidates explicitly. Ask before editing.`;
      }
      return `In ${projectKey}, many short Opus turns (output < 500 tokens) ran in the past 7 days and would have been much cheaper on Sonnet. Audit how Opus is invoked here — slash commands, agents, default model — and propose where to switch to Sonnet without hurting quality. List candidates explicitly. Ask before editing.`;
    case "tool-bloat":
      return `In ${projectKey}, several tool results exceeded 50k tokens in the past 7 days. Find which Bash/Read calls produce huge outputs and propose narrower alternatives (head/tail, ripgrep with file scope, targeted Read offsets, ctx_execute for analysis). Suggest hooks or CLAUDE.md guidance to prevent regressions. Ask before editing.`;
    case "subagent-outlier":
      return `Subagent ${t.title.match(/Subagent (\S+)/)?.[1] || ""}${proj} shows large outlier invocations vs its mean. Investigate what those outlier calls were doing (input size, prompts, tools used) and propose how to bound them — input trimming, tighter prompts, max-tokens, or splitting the work. Ask before editing.`;
    case "repeat-file":
      if (t._merged) {
        const list = t.rows.map((r) => `  - ${r}`).join("\n");
        return `In ${projectKey}, these files were re-opened many times in the past 7 days:\n${list}\n\nFor each, decide: (a) summarise in CLAUDE.md so Claude doesn't need to re-read, (b) split into smaller files, or (c) cache the relevant part inline. Propose a per-file plan, then wait for approval before editing.`;
      }
      return `In ${projectKey}, ${t.target || "this file"} was opened ${t.count} times in the past 7 days across ${t.sessions} sessions. Propose how to avoid the re-reads: a CLAUDE.md summary of the key facts, splitting the file, or caching its essence in a sibling note. Ask before editing.`;
    case "repeat-bash":
      if (t._merged) {
        const list = t.rows.map((r) => `  - ${r}`).join("\n");
        return `In ${projectKey}, these bash commands ran many times in the past 7 days:\n${list}\n\nFor each, propose a faster alternative: shell alias, npm/justfile script, --watch flag, or a hook that runs it automatically. Then suggest the smallest set of changes to set them up. Ask before editing.`;
      }
      return `In ${projectKey}, \`${t.target || ""}\` ran ${t.count} times in the past 7 days. Propose a faster way to invoke it (alias, watch flag, hook, or script) and the change required to set it up. Ask before editing.`;
    default:
      return `${t.title}\n\n${t.body}\n\nPropose a concrete fix${proj}. Ask before making changes.`;
  }
};

const tipToneVar = (type) =>
  type === "warn" ? "var(--warn)"
    : type === "good" ? "var(--good)"
    : "var(--gull)";

const TipCard = ({ t, projectKey, onDismiss }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const prompt = buildTipPrompt(t, projectKey);
  const onCopy = async () => {
    const ok = await copyToClipboard(prompt);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };
  const onDismissClick = async () => {
    setDismissing(true);
    await onDismiss(t);
    // On failure the card is restored by the parent; reset so it stays clickable.
    setDismissing(false);
  };
  return (
    <div className={`a-tip a-tip-${t.type}`}>
      <Label>
        {t.category ? (TIP_CATEGORY_LABELS[t.category] || t.type) : t.type}
      </Label>
      <div className="a-tip-body">
        <h3>{t.title}</h3>
        <p>{t.body}</p>
        {t._merged && (
          <ul className="a-tip-list">
            {t.rows.map((r, j) => <li key={j}>{r}</li>)}
          </ul>
        )}
        <div className="a-tip-actions">
          <button className="a-tip-btn" onClick={() => setOpen(!open)}>{open ? "hide prompt" : "show prompt"}</button>
          <button className="a-tip-btn" onClick={onCopy}>{copied ? "copied" : "copy prompt"}</button>
          <button className="a-tip-btn" onClick={onDismissClick} disabled={dismissing}>{dismissing ? "dismissing…" : "dismiss"}</button>
        </div>
        {open && <pre className="a-tip-prompt">{prompt}</pre>}
      </div>
    </div>
  );
};

const mergeRightSize = (list, slug) => {
  if (list.length === 1) return list[0];
  list.sort((a, b) => (b.count || 0) - (a.count || 0));
  const sum = (k) => list.reduce((acc, t) => acc + (Number(t[k]) || 0), 0);
  const count = sum("count");
  const apiOpus = sum("api_opus") / 100;
  const apiSonnet = sum("api_sonnet") / 100;
  const savings = sum("savings") / 100;
  return {
    _merged: true,
    _keys: list.map((t) => t.key).filter(Boolean),
    type: list[0].type || "info",
    category: "right-size",
    title: `${count} short Opus turns across ${list.length} worktrees in ${slug} might fit on Sonnet`,
    body: `Opus turns under 500 output tokens cost ~$${apiOpus.toFixed(2)} in the last 7 days. Sonnet would have cost ~$${apiSonnet.toFixed(2)} (savings ~$${savings.toFixed(2)}).`,
    count,
    rows: list.map((t) => `${slugTail(t.project_slug)} · ${t.count || 0} turns · ~$${((Number(t.savings) || 0) / 100).toFixed(2)} savings`),
  };
};

const mergeTipsByCategory = (tips, projectKey) => {
  const out = [];
  const buckets = {};
  tips.forEach((t) => {
    const cat = t.category;
    if (cat === "repeat-file" || cat === "repeat-bash" || cat === "right-size") {
      (buckets[cat] = buckets[cat] || []).push(t);
    } else {
      out.push(t);
    }
  });
  const slug = projectKey === "__global__" ? "(unknown project)" : projectKey;
  Object.entries(buckets).forEach(([cat, list]) => {
    if (cat === "right-size") {
      out.push(mergeRightSize(list, slug));
      return;
    }
    if (list.length === 1) { out.push(list[0]); return; }
    list.sort((a, b) => (b.count || 0) - (a.count || 0));
    out.push({
      _merged: true,
      _keys: list.map((t) => t.key).filter(Boolean),
      type: list[0].type || "info",
      category: cat,
      title: cat === "repeat-file"
        ? `${list.length} files read repeatedly in ${slug}`
        : `${list.length} bash commands re-run in ${slug}`,
      body: TIP_MERGE_BODY[cat],
      rows: list.map((t) =>
        cat === "repeat-file"
          ? `${t.target} · ${t.count} reads${t.sessions ? ` across ${t.sessions} sessions` : ""}`
          : `${t.target} · ${t.count} runs`),
    });
  });
  return out;
};

const TipsGroup = ({ groupKey, tips, defaultOpen, onDismiss }) => {
  const storageKey = `tips.open.${groupKey}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(storageKey);
    return v === null ? defaultOpen : v === "1";
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(storageKey, next ? "1" : "0");
  };
  const merged = mergeTipsByCategory(tips, groupKey);
  return (
    <div className={`a-tips-group ${open ? "is-open" : "is-collapsed"}`}>
      <button type="button" className="a-tips-group-head" onClick={toggle} aria-expanded={open}>
        <span className="a-tips-group-head-left">
          <span className="a-tips-group-caret">{open ? "▾" : "▸"}</span>
          <Label>{groupKey === "__global__" ? "global" : groupKey}</Label>
        </span>
        <span className="a-card-meta">{merged.length} tip{merged.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="a-tips">
          {merged.map((t, i) => <TipCard key={i} t={t} projectKey={groupKey} onDismiss={onDismiss} />)}
        </div>
      )}
    </div>
  );
};

// Claude Code project slug shape: drive + path joined with single dashes,
// with `--` between the drive letter and the rest (e.g. `C--Users-guill-...`).
// Heuristic: collapse to the project basename so worktrees, mixed casing,
// and slightly different ancestor paths still bucket into one project.
const normalizeProjectSlug = (slug) => {
  if (!slug) return "__global__";
  let s = slug;
  const wt = s.indexOf("--claude-worktrees-");
  if (wt !== -1) s = s.slice(0, wt);
  // Strip everything up to and including `-git-` if present (covers
  // `~/git/<project>` and `~/Documents/git/<project>` layouts).
  const m = s.match(/-git-(.+)$/i);
  if (m && m[1]) return m[1].toLowerCase();
  // Otherwise, take the segment after the last single dash that follows
  // a non-drive path component. Fall back to the original slug.
  const tail = s.split(/-+/).filter(Boolean).pop();
  return (tail || s).toLowerCase();
};

const groupTipsByProject = (tips) => {
  const groups = {};
  tips.forEach((t) => {
    const k = normalizeProjectSlug(t.project_slug);
    (groups[k] = groups[k] || []).push(t);
  });
  return groups;
};

const sortedGroupKeys = (groups) =>
  Object.keys(groups).sort((a, b) => {
    if (a === "__global__") return 1;
    if (b === "__global__") return -1;
    return a.localeCompare(b);
  });

const postDismiss = async (key) => {
  const r = await fetch("/api/tips/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error("dismiss failed");
};

export const Tips = () => {
  const [dismissed, setDismissed] = useState(() => new Set());
  const dismissTip = async (t) => {
    const keys = t._keys || (t.key ? [t.key] : []);
    if (keys.length === 0) return;
    setDismissed((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => n.add(k));
      return n;
    });
    try {
      await Promise.all(keys.map(postDismiss));
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    } catch (_) {
      // Restore the card so the dismissal isn't lost silently.
      setDismissed((prev) => {
        const n = new Set(prev);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  };
  const visible = (D.tips || []).filter((t) => !dismissed.has(t.key));
  const groups = groupTipsByProject(visible);
  const keys = sortedGroupKeys(groups);
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head"><h2>Tips</h2><span className="a-card-meta">rule-based suggestions · no telemetry · dismissed tips return after 14 days if the pattern persists</span></div>
        {keys.length === 0 && (
          <div className="muted" style={{ padding: "12px 16px" }}>
            No tips yet — the rule engine hasn't flagged anything in the current window.
            Tips appear once usage crosses thresholds (low cache hit rate, repeated file reads,
            tool-result bloat, etc.). Try widening the date range from the top bar.
          </div>
        )}
        {keys.map((k, idx) => (
          <TipsGroup key={k} groupKey={k} tips={groups[k]} defaultOpen={idx === 0} onDismiss={dismissTip} />
        ))}
      </section>
    </div>
  );
};
