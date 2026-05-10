//! Skill catalog: locate `SKILL.md` files and map slugs to file sizes.
//!
//! Direct port of `token_dashboard/skills.py`. Walked roots default to
//! the same three directories python checks. The cli enriches
//! `/api/skills` with the catalog's `tokens_per_call` field (chars / 4)
//! so the Skills tab can show context cost per invocation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct SkillEntry {
    pub path: String,
    pub chars: i64,
    pub tokens: i64,
}

const STRUCTURE_NAMES: &[&str] = &["skills", "plugins", "marketplaces", "cache", ".claude"];

fn looks_like_version(seg: &str) -> bool {
    let mut parts = seg.splitn(2, '.');
    let head = parts.next().unwrap_or("");
    let tail = parts.next().unwrap_or("");
    !head.is_empty()
        && head.chars().all(|c| c.is_ascii_digit())
        && tail.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// Slugs a Skill tool invocation could use to load this file. Mirrors
/// python `_slugs_for`. Always registers the bare skill name and, where
/// the path includes a `skills/` ancestor, also `<plugin>:<skill>` for
/// every ancestor segment that plausibly names a plugin.
pub fn slugs_for(skill_md: &Path) -> Vec<String> {
    if skill_md.file_name().and_then(|s| s.to_str()) != Some("SKILL.md") {
        return Vec::new();
    }
    let parts: Vec<&str> = skill_md
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let skill_name = match skill_md
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
    {
        Some(n) => n.to_string(),
        None => return Vec::new(),
    };
    let mut slugs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    slugs.insert(skill_name.clone());

    let skills_idx = match parts.iter().rposition(|p| *p == "skills") {
        Some(i) => i,
        None => return slugs.into_iter().collect(),
    };
    for seg in &parts[..skills_idx] {
        if seg.is_empty() || STRUCTURE_NAMES.contains(seg) {
            continue;
        }
        if looks_like_version(seg) {
            continue;
        }
        if seg.starts_with("temp_git_") {
            continue;
        }
        if seg.contains(':') {
            // Drive letters on Windows ("C:"), and the slug separator we use.
            continue;
        }
        slugs.insert(format!("{seg}:{skill_name}"));
    }
    slugs.into_iter().collect()
}

pub fn default_roots() -> Vec<PathBuf> {
    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };
    let claude = home.join(".claude");
    vec![
        claude.join("skills"),
        claude.join("scheduled-tasks"),
        claude.join("plugins"),
    ]
}

pub fn scan_catalog(roots: &[PathBuf]) -> HashMap<String, SkillEntry> {
    let mut catalog: HashMap<String, SkillEntry> = HashMap::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            if entry.file_name() != "SKILL.md" {
                continue;
            }
            let chars = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
            let path_str = entry.path().to_string_lossy().into_owned();
            let entry_v = SkillEntry {
                path: path_str.clone(),
                chars,
                tokens: chars / 4,
            };
            for slug in slugs_for(entry.path()) {
                let depth = entry.path().components().count();
                let keep = match catalog.get(&slug) {
                    None => true,
                    Some(prev) => Path::new(&prev.path).components().count() > depth,
                };
                if keep {
                    catalog.insert(slug, entry_v.clone());
                }
            }
        }
    }
    catalog
}

struct Cached {
    at: Instant,
    data: HashMap<String, SkillEntry>,
}

const TTL: Duration = Duration::from_secs(60);

fn cache_cell() -> &'static Mutex<Option<Cached>> {
    static CELL: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// `scan_catalog` with a 60-second in-process TTL. Mirrors python.
pub fn cached_catalog() -> HashMap<String, SkillEntry> {
    let mut guard = cache_cell().lock().expect("cache lock poisoned");
    if let Some(c) = guard.as_ref() {
        if c.at.elapsed() < TTL {
            return c.data.clone();
        }
    }
    let fresh = scan_catalog(&default_roots());
    *guard = Some(Cached {
        at: Instant::now(),
        data: fresh.clone(),
    });
    fresh
}

pub fn tokens_for(slug: &str, catalog: &HashMap<String, SkillEntry>) -> Option<i64> {
    catalog.get(slug).map(|e| e.tokens)
}

/// Force-clear the cache. Tests use this between scans of different
/// fixture roots; production code never needs it.
pub fn clear_cache() {
    if let Ok(mut g) = cache_cell().lock() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn slug_derivation_bare_includes_skill_name() {
        let p = PathBuf::from("/home/x/.claude/skills/brainstorm/SKILL.md");
        let slugs = slugs_for(&p);
        assert!(slugs.contains(&"brainstorm".to_string()));
        // .claude is in STRUCTURE_NAMES so the `.claude:` qualifier is
        // never produced — confirm. (Other path segments like "home"
        // *do* generate slugs in python; treated as harmless extras.)
        assert!(!slugs.iter().any(|s| s == ".claude:brainstorm"));
    }

    #[test]
    fn slug_derivation_plugin_qualified() {
        let p = PathBuf::from(
            "/home/x/.claude/plugins/marketplaces/main/plugins/superpowers/skills/brainstorm/SKILL.md",
        );
        let slugs = slugs_for(&p);
        assert!(slugs.contains(&"brainstorm".to_string()));
        assert!(slugs.contains(&"superpowers:brainstorm".to_string()));
        // Structural names that ARE in STRUCTURE_NAMES must not appear.
        assert!(!slugs.iter().any(|s| s == "marketplaces:brainstorm"
            || s == "plugins:brainstorm"
            || s == ".claude:brainstorm"));
    }

    #[test]
    fn slug_derivation_skips_version_dirs() {
        let p = PathBuf::from(
            "/home/x/.claude/plugins/cache/main/coolpkg/1.2.3/skills/coolskill/SKILL.md",
        );
        let slugs = slugs_for(&p);
        assert!(slugs.contains(&"coolpkg:coolskill".to_string()));
        // version + structural segments stay out.
        assert!(!slugs
            .iter()
            .any(|s| s == "1.2.3:coolskill" || s == "cache:coolskill"));
    }

    #[test]
    fn scan_catalog_finds_skill_md() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("skills").join("hello");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "x".repeat(400)).unwrap();
        let cat = scan_catalog(&[tmp.path().to_path_buf()]);
        let entry = cat.get("hello").expect("hello slug present");
        assert_eq!(entry.chars, 400);
        assert_eq!(entry.tokens, 100);
    }
}
