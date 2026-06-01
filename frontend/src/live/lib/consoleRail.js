const LOCAL_PROJECT = "local run";

/** Derive the local session's project label from the chosen cwd: its basename,
 *  or "local run" when no cwd is set. Tolerates trailing and Windows separators. */
export function cwdLabel(cwd) {
  if (!cwd) return LOCAL_PROJECT;
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base || LOCAL_PROJECT;
}

/** Parent-repo label for a git-worktree cwd (.../<repo>/.claude/worktrees/<name>).
 *  Returns the segment just before `.claude` so worktrees nest under their repo;
 *  undefined when the cwd isn't inside a worktree. */
export function repoLabel(cwd) {
  if (!cwd) return undefined;
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  const i = parts.findIndex((p, idx) => p === ".claude" && parts[idx + 1] === "worktrees");
  return i > 0 ? parts[i - 1] : undefined;
}

/** Group rail entries by their working directory. Entries with no cwd fall back
 *  to `appCwd`; if that is also undefined they collect under an empty-key group.
 *  Sessions sort newest-first within a group; groups sort by their newest member. */
export function buildRail(entries, appCwd) {
  const groups = new Map();
  for (const e of entries) {
    const dir = e.cwd ?? appCwd ?? "";
    (groups.get(dir) ?? groups.set(dir, []).get(dir)).push(e);
  }
  const out = [];
  for (const [dir, sessions] of groups) {
    sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    out.push({ dir, label: dir ? cwdLabel(dir) : "local", repo: repoLabel(dir), sessions });
  }
  out.sort((a, b) => (b.sessions[0]?.lastActivityMs ?? 0) - (a.sessions[0]?.lastActivityMs ?? 0));
  return out;
}
