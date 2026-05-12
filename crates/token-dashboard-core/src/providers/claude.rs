//! Claude Code provider — thin wrapper around the existing
//! [`crate::scanner`] entry points.
//!
//! Keeping `scanner.rs` untouched in v4.1 minimises diff risk; the actual
//! file move (`scanner.rs` → here, with `scanner.rs` as a re-export shim)
//! is scheduled for a follow-up release once Codex/Ollama have validated
//! the trait shape against real data.

use std::path::PathBuf;

use super::{Provider, ScanOpts, ScanReport};
use crate::scanner::{scan_dir, ScanStats};

/// Claude Code provider. Reads `~/.claude/projects/<slug>/<session>.jsonl`.
///
/// `CLAUDE_PROJECTS_DIR` env var still overrides the default root for
/// backwards compatibility, but [`ScanOpts::root_override`] takes
/// precedence when both are set so tests can stay hermetic.
pub struct Claude;

impl Claude {
    fn resolve_root(&self, opts: &ScanOpts) -> PathBuf {
        if let Some(root) = opts.root_override.as_ref() {
            return root.clone();
        }
        if let Some(env) = std::env::var_os("CLAUDE_PROJECTS_DIR") {
            return PathBuf::from(env);
        }
        self.default_root()
            .unwrap_or_else(|| PathBuf::from(".claude/projects"))
    }
}

impl Provider for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn default_root(&self) -> Option<PathBuf> {
        // Mirrors `db::default_db_path` resolution: HOME / USERPROFILE /
        // cwd, all under `.claude/projects`.
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)?;
        Some(home.join(".claude").join("projects"))
    }

    fn scan(&self, opts: &ScanOpts) -> rusqlite::Result<ScanReport> {
        let root = self.resolve_root(opts);
        let stats = scan_dir(&root, &opts.db_path)?;
        Ok(stats_to_report(self.id(), stats))
    }
}

fn stats_to_report(id: &'static str, s: ScanStats) -> ScanReport {
    ScanReport {
        provider: id,
        messages: s.messages,
        tools: s.tools,
        files: s.files,
        sessions: s.sessions,
        projects: s.projects,
        days: s.days,
        models: s.models,
        min_ts: s.min_ts,
        max_ts: s.max_ts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_and_label_are_stable() {
        let c = Claude;
        assert_eq!(c.id(), "claude");
        assert_eq!(c.label(), "Claude Code");
    }

    #[test]
    fn default_root_under_home_when_set() {
        // Sanity: when HOME is set the default_root resolves under it.
        // The test sets a deterministic value so the assertion holds on
        // Windows (USERPROFILE-only) and *nix (HOME) alike.
        let prev_home = std::env::var_os("HOME");
        let prev_user = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", "/tmp/td-test-home");
        let root = Claude.default_root().unwrap();
        assert!(root.ends_with(".claude/projects") || root.ends_with(".claude\\projects"));
        // Restore.
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match prev_user {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }
}
