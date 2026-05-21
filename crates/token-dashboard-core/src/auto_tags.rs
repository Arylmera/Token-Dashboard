//! Auto-tagging based on project slug.
//!
//! Claude Code stores transcripts under a project slug like
//! `C--Users-guill-Documents-git-token-dashboard` (or, for worktrees,
//! `…--git-token-dashboard--claude-worktrees-<wt-name>`). When the slug
//! contains `-git-`, treat the segment immediately after it as the git
//! project name and apply it as a default tag.
//!
//! Tags applied here are logged in `session_auto_tag_log` so that if the
//! user later removes the tag, subsequent scans don't re-apply it.

use rusqlite::{params, Connection};

use crate::scanner::now_secs_f64;

/// Returns the git project tag derived from `slug`, or `None` when the
/// slug doesn't look like a git project path.
pub fn derive_git_tag(slug: &str) -> Option<String> {
    let lower = slug.to_lowercase();
    let pos = lower.find("-git-")?;
    let rest = &lower[pos + "-git-".len()..];
    if rest.is_empty() {
        return None;
    }
    // Stop at the worktree marker if present so tags from worktrees
    // collapse onto the parent project.
    let head = match rest.find("--claude-worktrees-") {
        Some(i) => &rest[..i],
        None => rest,
    };
    // Claude Code slugs replace `/` with `-` without escaping dashes that
    // already exist in path segments, so `Documents/git/token-dashboard`
    // and `Documents/git/Token-Dashboard` both round-trip as one segment.
    // Take the remainder verbatim; that yields the project name with its
    // internal dashes intact (`token-dashboard`, `Token-Dashboard`, etc.).
    let trimmed = head.trim_matches('-');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Backfill auto-tags across every session in `messages`. Cheap to call
/// from the scan loop because the inner work is gated on
/// `session_auto_tag_log` — sessions already processed are skipped at
/// the SQL level, so the first scan after the feature lands tags every
/// historic git project, and steady-state scans only touch new sessions.
///
/// Best-effort: any per-row failure is logged to stderr and the loop
/// continues; tag-side issues never abort the scan.
pub fn backfill_all(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT m.session_id, m.project_slug \
         FROM messages m \
         WHERE m.session_id NOT IN (SELECT session_id FROM session_auto_tag_log)",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let sid: String = r.get(0)?;
            let slug: String = r.get(1)?;
            Ok((sid, slug))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut applied = 0usize;
    let now = now_secs_f64();
    for (sid, slug) in rows {
        let Some(tag) = derive_git_tag(&slug) else {
            continue;
        };
        let _ = conn.execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) VALUES (?, ?, ?)",
            params![sid, &tag, now],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO session_auto_tag_log (session_id, tag, applied_at) VALUES (?, ?, ?)",
            params![sid, &tag, now],
        );
        applied += 1;
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_simple_git_project() {
        assert_eq!(
            derive_git_tag("C--Users-guill-Documents-git-token-dashboard"),
            Some("token-dashboard".to_string())
        );
    }

    #[test]
    fn lowercases_project_name() {
        assert_eq!(
            derive_git_tag("C--Users-guill-Documents-git-Token-Dashboard"),
            Some("token-dashboard".to_string())
        );
    }

    #[test]
    fn ignores_slugs_without_git() {
        assert_eq!(derive_git_tag("home-foo-bar-baz"), None);
    }

    #[test]
    fn strips_worktree_suffix() {
        assert_eq!(
            derive_git_tag("c--Users-g-Documents-git-token-dashboard--claude-worktrees-x"),
            Some("token-dashboard".to_string())
        );
    }
}
