// Mirror of `token_dashboard_core::budget_projects::project_name_segment`
// (crates/token-dashboard-core/src/budget_projects.rs). Strips
// `--claude-worktrees-...` suffixes and walks past the last `-git-` /
// `-Github-` / `-GitHub-` marker so worktrees + clones collapse to the
// same display name. Keep this in sync with the Rust function.

export function projectNameSegment(slug) {
  if (!slug) return "";
  const base = String(slug).split("--claude-worktrees-")[0];
  for (const marker of ["-git-", "-Github-", "-GitHub-"]) {
    const idx = base.lastIndexOf(marker);
    if (idx >= 0) return base.slice(idx + marker.length);
  }
  return base;
}

// What the UI shows in a project column. Preserves casing; falls back to
// the raw slug when nothing can be extracted.
export function displayProject(slug) {
  if (!slug) return "";
  const seg = projectNameSegment(slug);
  return seg || String(slug);
}
