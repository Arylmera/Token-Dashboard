use serde::Serialize;
use serde_json::Value;

/// Graph/console-relevant events extracted from a transcript line.
#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "data"
)]
pub enum SessionEvent {
    Turn {
        role: String,
        text: String,
    },
    SubagentSpawn {
        tool_use_id: String,
        subagent_type: String,
    },
    ToolActivity {
        tool_use_id: String,
        name: String,
        file_path: Option<String>,
    },
    ToolDone {
        tool_use_id: String,
        is_error: bool,
        error: Option<String>,
    },
}

/// Extract human-readable text from a tool_result `content` field (a bare string
/// or an array of text blocks). Surfaces *why* a call failed. None if empty.
fn tool_result_text(content: Option<&Value>) -> Option<String> {
    let s = match content? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn content_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|b| {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string()),
                Some("tool_use") => {
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    // Subagent spawns get their own named branch in the console; skip the
                    // redundant "[Agent]" placeholder in the parent's turn text.
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
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse one transcript line into zero or more SessionEvents (tolerant).
pub fn parse_transcript_line(line: &str) -> Vec<SessionEvent> {
    let v: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ty = match v.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return vec![],
    };
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return vec![];
    }
    if v.get("isApiErrorMessage")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return vec![];
    }
    let msg = match v.get("message") {
        Some(m) => m,
        None => return vec![],
    };
    if msg.get("model").and_then(|m| m.as_str()) == Some("<synthetic>") {
        return vec![];
    }
    let content = match msg.get("content") {
        Some(c) => c,
        None => return vec![],
    };
    let mut out = vec![];

    let role = msg
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or(ty)
        .to_string();
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => content_text(blocks),
        _ => String::new(),
    };
    let text = text.trim().to_string();
    if !text.is_empty() && !text.contains("local-command-caveat") && !text.starts_with("<command-")
    {
        out.push(SessionEvent::Turn { role, text });
    }

    if let Value::Array(blocks) = content {
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("tool_use") => {
                    let id = b
                        .get("id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = b
                        .get("name")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input = b.get("input");
                    if name == "Agent" || name == "Task" {
                        let st = input
                            .and_then(|i| i.get("subagent_type"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        out.push(SessionEvent::SubagentSpawn {
                            tool_use_id: id,
                            subagent_type: st,
                        });
                    } else {
                        let fp = input
                            .and_then(|i| i.get("file_path"))
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        out.push(SessionEvent::ToolActivity {
                            tool_use_id: id,
                            name,
                            file_path: fp,
                        });
                    }
                }
                Some("tool_result") => {
                    let id = b
                        .get("tool_use_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_error = b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                    // Keep the result text only on failure — that's the "what went wrong".
                    let error = if is_error {
                        tool_result_text(b.get("content"))
                    } else {
                        None
                    };
                    out.push(SessionEvent::ToolDone {
                        tool_use_id: id,
                        is_error,
                        error,
                    });
                }
                _ => {}
            }
        }
    }
    out
}

/// Return (new_lines, new_offset) for bytes appended after `offset`.
/// Only returns COMPLETE lines; a trailing partial line stays buffered.
pub fn tail_new(content: &str, offset: usize) -> (Vec<String>, usize) {
    if offset >= content.len() {
        return (vec![], content.len());
    }
    let fresh = &content[offset..];
    match fresh.rfind('\n') {
        Some(idx) => {
            let complete = &fresh[..=idx];
            let lines = complete.lines().map(|s| s.to_string()).collect();
            (lines, offset + idx + 1)
        }
        None => (vec![], offset),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spawn_and_file_activity() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a1","name":"Agent","input":{"subagent_type":"genetor"}},{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"/repo/a/b.md"}}]}}"#;
        let evs = parse_transcript_line(line);
        assert!(evs.contains(&SessionEvent::SubagentSpawn {
            tool_use_id: "a1".into(),
            subagent_type: "genetor".into()
        }));
        assert!(evs.contains(&SessionEvent::ToolActivity {
            tool_use_id: "r1".into(),
            name: "Read".into(),
            file_path: Some("/repo/a/b.md".into())
        }));
    }

    #[test]
    fn emits_turn_and_drops_meta() {
        assert_eq!(
            parse_transcript_line(
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}"#
            ),
            vec![]
        );
        let t =
            parse_transcript_line(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#);
        assert_eq!(
            t,
            vec![SessionEvent::Turn {
                role: "user".into(),
                text: "hello".into()
            }]
        );
    }

    #[test]
    fn parses_tool_result_into_tool_done() {
        // A master-level tool call's result (e.g. Read) lives in a user message.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r1","is_error":false}]}}"#;
        let evs = parse_transcript_line(line);
        assert_eq!(
            evs,
            vec![SessionEvent::ToolDone {
                tool_use_id: "r1".into(),
                is_error: false,
                error: None
            }]
        );
    }

    #[test]
    fn tool_result_error_flag_is_captured() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r2","is_error":true}]}}"#;
        let evs = parse_transcript_line(line);
        assert!(evs.contains(&SessionEvent::ToolDone {
            tool_use_id: "r2".into(),
            is_error: true,
            error: None
        }));
    }

    #[test]
    fn tool_result_missing_is_error_defaults_false() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r3"}]}}"#;
        let evs = parse_transcript_line(line);
        assert_eq!(
            evs,
            vec![SessionEvent::ToolDone {
                tool_use_id: "r3".into(),
                is_error: false,
                error: None
            }]
        );
    }

    #[test]
    fn tool_result_error_text_is_captured_from_string() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r4","is_error":true,"content":"File not found"}]}}"#;
        let evs = parse_transcript_line(line);
        assert_eq!(
            evs,
            vec![SessionEvent::ToolDone {
                tool_use_id: "r4".into(),
                is_error: true,
                error: Some("File not found".into())
            }]
        );
    }

    #[test]
    fn tool_result_error_text_is_captured_from_blocks() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r5","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}"#;
        let evs = parse_transcript_line(line);
        assert_eq!(
            evs,
            vec![SessionEvent::ToolDone {
                tool_use_id: "r5".into(),
                is_error: true,
                error: Some("boom".into())
            }]
        );
    }

    #[test]
    fn tail_only_complete_lines() {
        let (l, off) = tail_new("a\nb\n", 0);
        assert_eq!(l, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(off, 4);
        let (l2, off2) = tail_new("a\nb\nccc", off);
        assert!(l2.is_empty());
        assert_eq!(off2, 4);
        let (l3, off3) = tail_new("a\nb\nccc\n", off2);
        assert_eq!(l3, vec!["ccc".to_string()]);
        assert_eq!(off3, 8);
    }
}
