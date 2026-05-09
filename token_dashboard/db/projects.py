"""Project-slug decoding and pretty-name resolution.

Claude Code stores transcripts under `~/.claude/projects/<slug>/` where the slug
is the cwd with `:`, `\\`, `/`, and space each replaced by `-`. To get a readable
project name we walk the cwd up until an ancestor encodes back to that slug.
"""
from __future__ import annotations

import re
from typing import Optional


def _encode_slug(path: str) -> str:
    """Claude Code's project-slug encoding: each of `:`, `\\`, `/`, space → one `-`."""
    return re.sub(r"[:\\/ ]", "-", path)


def _walk_to_root(cwd: str, slug: str) -> Optional[str]:
    """If any ancestor of cwd encodes to slug, return that ancestor's basename."""
    if not cwd or not slug:
        return None
    trimmed = cwd.rstrip("/\\")
    sep = "\\" if "\\" in trimmed else "/"
    parts = trimmed.split(sep)
    for i in range(len(parts), 0, -1):
        if _encode_slug(sep.join(parts[:i])) == slug:
            name = parts[i - 1]
            if name:
                return name
    return None


_WORKTREE_RE = re.compile(r"[\\/]\.claude[\\/]worktrees[\\/]", re.IGNORECASE)


def worktree_parent_name(cwd: Optional[str]) -> Optional[str]:
    """If `cwd` is inside a `.claude/worktrees/` dir, return the parent repo's basename.

    The `superpowers:using-git-worktrees` skill creates worktrees at
    `<repo>/.claude/worktrees/<adjective-name-hash>`. Without this, the
    dashboard would show the worktree's randomized name as the project.
    """
    if not cwd:
        return None
    m = _WORKTREE_RE.search(cwd)
    if not m:
        return None
    parent = cwd[: m.start()]
    if not parent:
        return None
    sep = "\\" if "\\" in parent else "/"
    name = parent.rstrip("/\\").split(sep)[-1]
    return name or None


def project_name_for(cwd: Optional[str], fallback_slug: str) -> str:
    """Pretty project name from a single cwd + slug (best-effort).

    For the multi-cwd case, prefer `best_project_name`.
    """
    name = _walk_to_root(cwd or "", fallback_slug or "")
    if name:
        return name
    if cwd:
        trimmed = cwd.rstrip("/\\")
        sep = "\\" if "\\" in trimmed else "/"
        tail = trimmed.split(sep)[-1]
        if tail:
            return tail
    if fallback_slug:
        parts = [p for p in re.split(r"-+", fallback_slug) if p]
        if parts:
            return parts[-1]
    return fallback_slug or ""


def best_project_name(cwds, slug: str) -> str:
    """Pick a pretty name from a list of cwds.

    Prefer a cwd whose walk-up matches `slug` (a true descendant of the project
    root). If none match, fall back to `project_name_for` on the first cwd,
    then to the slug's last segment.
    """
    cwds = [c for c in (cwds or []) if c]
    for cwd in cwds:
        parent = worktree_parent_name(cwd)
        if parent:
            return parent
    for cwd in cwds:
        name = _walk_to_root(cwd, slug)
        if name:
            return name
    return project_name_for(cwds[0] if cwds else None, slug)
