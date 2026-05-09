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

const buildTipPrompt = (t, projectKey) => {
  const proj = projectKey === "__global__" ? "" : ` (project: ${projectKey})`;
  switch (t.category) {
    case "cache":
      return `In ${projectKey}, our Claude Code cache hit rate is below 40% over the last 7 days, meaning we keep rebuilding context instead of reusing it. Investigate the project for patterns that thrash the prompt cache: frequent /clear, redundant CLAUDE.md edits, large rotating system blocks, or sessions that load big files near the start. Propose concrete changes (CLAUDE.md restructuring, hook adjustments, session habits) that would lift the hit rate. Ask before editing files.`;
    case "right-size":
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

const TipCard = ({ t, projectKey }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = buildTipPrompt(t, projectKey);
  const onCopy = async () => {
    const ok = await copyToClipboard(prompt);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={`a-tip a-tip-${t.type}`}>
      <Label style={{ color: tipToneVar(t.type) }}>
        {t.category ? (TIP_CATEGORY_LABELS[t.category] || t.type) : t.type}
      </Label>
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
      </div>
      {open && <pre className="a-tip-prompt">{prompt}</pre>}
    </div>
  );
};

const mergeTipsByCategory = (tips, projectKey) => {
  const out = [];
  const buckets = {};
  tips.forEach((t) => {
    const cat = t.category;
    if (cat === "repeat-file" || cat === "repeat-bash") {
      (buckets[cat] = buckets[cat] || []).push(t);
    } else {
      out.push(t);
    }
  });
  Object.entries(buckets).forEach(([cat, list]) => {
    if (list.length === 1) { out.push(list[0]); return; }
    const slug = projectKey === "__global__" ? "(unknown project)" : projectKey;
    list.sort((a, b) => (b.count || 0) - (a.count || 0));
    out.push({
      _merged: true,
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

const TipsGroup = ({ groupKey, tips, defaultOpen }) => {
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
          {merged.map((t, i) => <TipCard key={i} t={t} projectKey={groupKey} />)}
        </div>
      )}
    </div>
  );
};

const normalizeProjectSlug = (slug) => {
  if (!slug) return "__global__";
  const i = slug.indexOf("--claude-worktrees-");
  return i === -1 ? slug : slug.slice(0, i);
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

export const Tips = () => {
  const groups = groupTipsByProject(D.tips || []);
  const keys = sortedGroupKeys(groups);
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head"><h2>Tips</h2><span className="a-card-meta">rule-based suggestions · no telemetry</span></div>
        {keys.map((k, idx) => (
          <TipsGroup key={k} groupKey={k} tips={groups[k]} defaultOpen={idx === 0} />
        ))}
      </section>
    </div>
  );
};
