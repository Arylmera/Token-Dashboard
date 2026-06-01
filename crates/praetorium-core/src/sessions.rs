use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub mtime_ms: u64,
    pub title: String,
    pub size_bytes: u64,
    pub location: String,    // real cwd (from transcript) or decoded folder name
    pub project_dir: String, // absolute path of the containing project folder
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub text: String,
    pub ts: String,
}

/// Flatten a transcript line's message into displayable text, or None if it's
/// not a real conversational turn.
pub fn line_to_turn(line: &str) -> Option<Turn> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let ty = v.get("type")?.as_str()?;
    if ty != "user" && ty != "assistant" {
        return None;
    }
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    // Drop synthetic / API-error lines (e.g. rate-limit notices) — not real turns.
    if v.get("isApiErrorMessage")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let msg = v.get("message")?;
    if msg.get("model").and_then(|m| m.as_str()) == Some("<synthetic>") {
        return None;
    }
    let role = msg.get("role")?.as_str()?.to_string();
    let ts = v
        .get("timestamp")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let content = msg.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let parts: Vec<String> = blocks
                .iter()
                .filter_map(|b| {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => b
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string()),
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            // Subagent spawns render as their own named branch; skip the
                            // redundant "[Agent]" placeholder here.
                            if name == "Agent" || name == "Task" {
                                return None;
                            }
                            let fp = b
                                .get("input")
                                .and_then(|i| i.get("file_path"))
                                .and_then(|s| s.as_str());
                            Some(match fp {
                                Some(p) => format!("[{name} {p}]"),
                                None => format!("[{name}]"),
                            })
                        }
                        _ => None, // drop tool_result bulk
                    }
                })
                .collect();
            parts.join("\n")
        }
        _ => return None,
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if text.contains("local-command-caveat") || text.starts_with("<command-") {
        return None;
    }
    Some(Turn { role, text, ts })
}

/// Parse a session jsonl file into displayable turns (sync, std only).
pub fn read_session_sync(path: &Path) -> Result<Vec<Turn>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    Ok(raw.lines().filter_map(line_to_turn).collect())
}

/// First `"cwd"` string field found scanning transcript lines.
pub fn first_cwd(raw: &str) -> Option<String> {
    for line in raw.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Best-effort reverse of Claude Code's project-dir encoding. The encoding is
/// lossy (every separator becomes `-`), so this only runs as a fallback when no
/// transcript line carries a `cwd`. Heuristic: a leading single drive letter
/// followed by `--` becomes `X:\`, remaining single `-` become `\`.
pub fn decode_project_name(name: &str) -> String {
    let mut out = String::new();
    let bytes = name.as_bytes();
    // Drive prefix: "C--" => "C:\"
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b'-' && bytes[2] == b'-' {
        out.push(bytes[0] as char);
        out.push(':');
        out.push('\\');
        out.push_str(&name[3..].replace('-', "\\"));
    } else {
        out.push_str(&name.replace('-', "\\"));
    }
    out
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// List top-level session logs (ignores the subagents/ subdir).
pub fn list_sessions(project_dir: &Path) -> Result<Vec<SessionMeta>, String> {
    let rd = std::fs::read_dir(project_dir).map_err(|e| format!("read dir failed: {e}"))?;
    let project_dir_str = project_dir.to_string_lossy().to_string();
    let mut out = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_bytes = meta.len();
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let title = raw
            .lines()
            .find_map(line_to_turn)
            .map(|t| t.text.chars().take(80).collect::<String>())
            .unwrap_or_else(|| id.clone());
        let location = first_cwd(&raw).unwrap_or_else(|| project_dir_str.clone());
        out.push(SessionMeta {
            id,
            mtime_ms,
            title,
            size_bytes,
            location,
            project_dir: project_dir_str.clone(),
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.mtime_ms));
    Ok(out)
}

/// Scan ~/.claude/projects/*/ and return every top-level session.
pub fn list_all_sessions() -> Result<Vec<SessionMeta>, String> {
    let mut root = home_dir().ok_or("no home dir")?;
    root.push(".claude");
    root.push("projects");
    let projects = std::fs::read_dir(&root).map_err(|e| format!("read projects failed: {e}"))?;
    let mut out = vec![];
    for proj in projects.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        let dir_name = proj_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let project_dir_str = proj_path.to_string_lossy().to_string();
        let rd = match std::fs::read_dir(&proj_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size_bytes = meta.len();
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            let title = raw
                .lines()
                .find_map(line_to_turn)
                .map(|t| t.text.chars().take(80).collect::<String>())
                .unwrap_or_else(|| id.clone());
            let location = first_cwd(&raw).unwrap_or_else(|| decode_project_name(&dir_name));
            out.push(SessionMeta {
                id,
                mtime_ms,
                title,
                size_bytes,
                location,
                project_dir: project_dir_str.clone(),
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.mtime_ms));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_cwd_reads_the_cwd_field_from_the_first_line_that_has_one() {
        let raw =
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"C:/work/proj\",\"message\":{}}\n";
        assert_eq!(first_cwd(raw).as_deref(), Some("C:/work/proj"));
    }

    #[test]
    fn first_cwd_is_none_when_absent() {
        assert_eq!(first_cwd("{\"type\":\"user\"}\n"), None);
    }

    #[test]
    fn decode_project_name_turns_dashes_back_into_a_path() {
        assert_eq!(
            decode_project_name("C--Users-guill-git-Terra"),
            "C:\\Users\\guill\\git\\Terra"
        );
    }
}
