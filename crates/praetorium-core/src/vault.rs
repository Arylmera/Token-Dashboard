use std::collections::HashMap;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub rel: String,
    pub name: String,
    pub dir: String,
}

pub fn walk_md(root: &Path, base: &Path, out: &mut Vec<VaultFile>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if file_name == "Archive" || file_name == ".git" || file_name == "node_modules" {
                continue;
            }
            walk_md(&path, base, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let dir = Path::new(&rel)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(VaultFile { rel, name, dir });
        }
    }
}

/// List all .md files under the vault (skips Archive/.git/node_modules).
pub fn vault_index_sync(vault_path: &Path) -> Result<Vec<VaultFile>, String> {
    if !vault_path.is_dir() {
        return Err(format!("not a directory: {}", vault_path.display()));
    }
    let mut out = vec![];
    walk_md(vault_path, vault_path, &mut out);
    Ok(out)
}

/// Read a UTF-8 file from disk (sync). Only .md files allowed.
pub fn read_vault_file_sync(path: &Path) -> Result<String, String> {
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("only .md files may be read".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))
}

/// A single note's resolved outgoing wikilinks plus a count of dangling targets.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinks {
    pub rel: String,
    pub links: Vec<String>,
    pub unresolved: u32,
}

/// Wikilink matcher: `[[target]]` / `[[target|alias]]`
pub fn link_re() -> Regex {
    Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").expect("static regex")
}

/// Extract wikilink targets (trimmed) from note text.
pub fn extract_targets(content: &str, re: &Regex) -> Vec<String> {
    re.captures_iter(content)
        .map(|c| c[1].trim().to_string())
        .collect()
}

/// Build a name index keyed by lowercased note stem → relative path.
pub fn name_index(files: &[VaultFile]) -> HashMap<String, String> {
    files
        .iter()
        .map(|f| (f.name.to_lowercase(), f.rel.clone()))
        .collect()
}

/// Resolve a list of link targets against the name index.
pub fn resolve_links(targets: &[String], index: &HashMap<String, String>) -> (Vec<String>, u32) {
    let mut resolved = vec![];
    let mut unresolved = 0u32;
    let mut seen = std::collections::HashSet::new();
    for t in targets {
        let key = t.to_lowercase();
        if let Some(rel) = index.get(&key) {
            if seen.insert(rel.clone()) {
                resolved.push(rel.clone());
            }
        } else {
            unresolved = unresolved.saturating_add(1);
        }
    }
    (resolved, unresolved)
}

/// Pure core: given (rel, content) notes and a name index, build the adjacency.
pub fn build_links(
    notes: &[(String, String)],
    index: &HashMap<String, String>,
    re: &Regex,
) -> Vec<NoteLinks> {
    notes
        .iter()
        .map(|(rel, content)| {
            let (links, unresolved) = resolve_links(&extract_targets(content, re), index);
            NoteLinks {
                rel: rel.clone(),
                links,
                unresolved,
            }
        })
        .collect()
}

/// Walk the vault's `.md` files and return each note's resolved `[[wikilink]]` adjacency.
pub fn vault_links_sync(vault_path: &Path) -> Result<Vec<NoteLinks>, String> {
    if !vault_path.is_dir() {
        return Err(format!("not a directory: {}", vault_path.display()));
    }
    let mut files = vec![];
    walk_md(vault_path, vault_path, &mut files);
    let index = name_index(&files);
    let re = link_re();

    let mut notes: Vec<(String, String)> = Vec::with_capacity(files.len());
    for f in &files {
        let abs = vault_path.join(f.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        match std::fs::read_to_string(&abs) {
            Ok(content) => notes.push((f.rel.clone(), content)),
            Err(_) => continue,
        }
    }
    Ok(build_links(&notes, &index, &re))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn extracts_plain_and_aliased_links() {
        let re = link_re();
        let targets = extract_targets("[[Terra]] [[Moon|home]]", &re);
        assert_eq!(targets, vec!["Terra", "Moon"]);
    }

    #[test]
    fn resolves_case_insensitive_dedup() {
        let re = link_re();
        let index = idx(&[("terra", "Terra.md")]);
        let (links, unresolved) = resolve_links(
            &extract_targets("[[Terra]] [[terra]] [[Terra|home]]", &re),
            &index,
        );
        assert_eq!(links, vec!["Terra.md".to_string()]);
        assert_eq!(unresolved, 0);
    }

    #[test]
    fn note_with_no_links_yields_empty() {
        let re = link_re();
        let index = idx(&[("terra", "Terra.md")]);
        let notes = vec![("A.md".to_string(), "no links at all".to_string())];
        let out = build_links(&notes, &index, &re);
        assert_eq!(
            out,
            vec![NoteLinks {
                rel: "A.md".into(),
                links: vec![],
                unresolved: 0
            }]
        );
    }

    #[test]
    fn code_fence_links_are_not_excluded_documented_limitation() {
        let re = link_re();
        let index = idx(&[("terra", "Terra.md")]);
        let (links, _) = resolve_links(&extract_targets("```\n[[Terra]]\n```", &re), &index);
        assert_eq!(links, vec!["Terra.md".to_string()]);
    }
}
