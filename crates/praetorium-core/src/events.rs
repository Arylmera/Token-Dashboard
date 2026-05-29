use serde::Serialize;

/// Wire type sent to the frontend. One variant per meaningful stream-json line.
/// `Unknown` is the tolerant catch-all (schema may evolve, never crash).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    content = "data"
)]
pub enum ClaudeEvent {
    /// Emitted when the run starts (stream-json "system"/"init" line).
    SystemInit { session_id: String },
    /// A complete assistant message's text content.
    AssistantText {
        text: String,
        parent_tool_use_id: Option<String>,
    },
    /// The terminal "result" line. `is_error` true on failure.
    Result { is_error: bool, result: String },
    /// Any line we don't model yet — kept for forward-compat, carries the raw type tag.
    Unknown { raw_type: String },
    /// Emitted by ProcessManager (not from claude) when the child exits.
    RunComplete { exit_code: i32 },
    /// Emitted by ProcessManager on spawn/IO failure.
    RunError { message: String },
    /// A subagent spawn: `tool_use` block named "Agent" (or legacy "Task").
    SubagentSpawn {
        tool_use_id: String,
        subagent_type: String,
        parent_tool_use_id: Option<String>,
    },
    /// Any non-Agent tool_use block. `file_path` set for Read/Edit/Write.
    ToolCall {
        tool_use_id: String,
        name: String,
        file_path: Option<String>,
        parent_tool_use_id: Option<String>,
    },
    /// A tool_result block closing a tool_use (or subagent).
    ToolResult {
        tool_use_id: String,
        is_error: bool,
        parent_tool_use_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_assistant_text_to_tagged_camelcase() {
        let ev = ClaudeEvent::AssistantText {
            text: "hello".into(),
            parent_tool_use_id: None,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "assistantText",
                "data": { "text": "hello", "parentToolUseId": null }
            })
        );
    }

    #[test]
    fn serialises_subagent_spawn_camelcase() {
        let ev = ClaudeEvent::SubagentSpawn {
            tool_use_id: "toolu_1".into(),
            subagent_type: "genetor".into(),
            parent_tool_use_id: None,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "subagentSpawn",
                "data": { "toolUseId": "toolu_1", "subagentType": "genetor", "parentToolUseId": null }
            })
        );
    }
}
