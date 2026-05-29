use crate::events::ClaudeEvent;
use serde_json::Value;

/// Parse one line of stream-json into zero or more events.
/// Blank/garbage lines yield an empty Vec (tolerant by design).
pub fn parse_line(line: &str) -> Vec<ClaudeEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ty = match v.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return vec![],
    };
    let parent = v
        .get("parent_tool_use_id")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    match ty {
        "system" => {
            let session_id = v
                .get("session_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            vec![ClaudeEvent::SystemInit { session_id }]
        }
        "assistant" => parse_assistant_blocks(&v, &parent),
        "user" => parse_user_blocks(&v, &parent),
        "result" => {
            let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
            let result = v
                .get("result")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            vec![ClaudeEvent::Result { is_error, result }]
        }
        other => vec![ClaudeEvent::Unknown {
            raw_type: other.to_string(),
        }],
    }
}

fn content_blocks(v: &Value) -> &[Value] {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

fn parse_assistant_blocks(v: &Value, parent: &Option<String>) -> Vec<ClaudeEvent> {
    let mut out = vec![];
    for b in content_blocks(v) {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(text) = b.get("text").and_then(|t| t.as_str()) {
                    out.push(ClaudeEvent::AssistantText {
                        text: text.to_string(),
                        parent_tool_use_id: parent.clone(),
                    });
                }
            }
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
                    let subagent_type = input
                        .and_then(|i| i.get("subagent_type"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    out.push(ClaudeEvent::SubagentSpawn {
                        tool_use_id: id,
                        subagent_type,
                        parent_tool_use_id: parent.clone(),
                    });
                } else {
                    let file_path = input
                        .and_then(|i| i.get("file_path"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    out.push(ClaudeEvent::ToolCall {
                        tool_use_id: id,
                        name,
                        file_path,
                        parent_tool_use_id: parent.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_user_blocks(v: &Value, parent: &Option<String>) -> Vec<ClaudeEvent> {
    let mut out = vec![];
    for b in content_blocks(v) {
        if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
            let id = b
                .get("tool_use_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
            out.push(ClaudeEvent::ToolResult {
                tool_use_id: id,
                is_error,
                parent_tool_use_id: parent.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_text_block_with_parent() {
        let line = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Hi"}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![ClaudeEvent::AssistantText {
                text: "Hi".into(),
                parent_tool_use_id: None
            }]
        );
    }

    #[test]
    fn parses_subagent_spawn() {
        let line = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"subagent_type":"genetor","prompt":"x"}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![ClaudeEvent::SubagentSpawn {
                tool_use_id: "toolu_1".into(),
                subagent_type: "genetor".into(),
                parent_tool_use_id: None
            }]
        );
    }

    #[test]
    fn parses_legacy_task_name_as_spawn() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Task","input":{"subagent_type":"lex"}}]}}"#;
        assert!(matches!(
            parse_line(line).as_slice(),
            [ClaudeEvent::SubagentSpawn { .. }]
        ));
    }

    #[test]
    fn parses_file_tool_call_with_path_and_parent() {
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/repo/src/lib/x.ts"}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![ClaudeEvent::ToolCall {
                tool_use_id: "t3".into(),
                name: "Edit".into(),
                file_path: Some("/repo/src/lib/x.ts".into()),
                parent_tool_use_id: Some("toolu_1".into())
            }]
        );
    }

    #[test]
    fn parses_tool_call_without_file_path() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"Bash","input":{"command":"ls"}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![ClaudeEvent::ToolCall {
                tool_use_id: "t4".into(),
                name: "Bash".into(),
                file_path: None,
                parent_tool_use_id: None
            }]
        );
    }

    #[test]
    fn parses_tool_result() {
        let line = r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false,"content":"ok"}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![ClaudeEvent::ToolResult {
                tool_use_id: "toolu_1".into(),
                is_error: false,
                parent_tool_use_id: None
            }]
        );
    }

    #[test]
    fn multiple_blocks_emit_multiple_events() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"go"},{"type":"tool_use","id":"t5","name":"Read","input":{"file_path":"/a/b.md"}}]}}"#;
        let evs = parse_line(line);
        assert_eq!(evs.len(), 2);
        assert!(matches!(evs[0], ClaudeEvent::AssistantText { .. }));
        assert!(matches!(evs[1], ClaudeEvent::ToolCall { .. }));
    }

    #[test]
    fn blank_and_garbage_yield_empty() {
        assert!(parse_line("").is_empty());
        assert!(parse_line("   ").is_empty());
        assert!(parse_line("not json").is_empty());
    }

    #[test]
    fn unknown_type_preserved() {
        assert_eq!(
            parse_line(r#"{"type":"foo"}"#),
            vec![ClaudeEvent::Unknown {
                raw_type: "foo".into()
            }]
        );
    }
}
