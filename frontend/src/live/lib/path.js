// String-only path helpers shared across the app. Every function tolerates both
// POSIX (`/`) and Windows (`\`) separators and never touches the filesystem.

/** Convert backslashes to forward slashes so a path can be split uniformly. */
export function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

/** Last path segment, ignoring trailing separators. Returns "" for an empty or
 *  separator-only path (callers supply their own fallback label). */
export function basename(p) {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
}

/** Parent directory in forward-slash form. Returns the whole (normalized) path
 *  when it has no parent — a bare name or a single root segment. */
export function dirname(p) {
  const norm = normalizePath(p);
  const i = norm.lastIndexOf("/");
  return i <= 0 ? norm : norm.slice(0, i);
}
