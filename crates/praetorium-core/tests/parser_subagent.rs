// Schema-authored fixture (a real capture needs a non-nested claude session; the
// wire shapes match the documented stream-json schema). Validates the enriched parser.
use praetorium_core::events::ClaudeEvent;
use praetorium_core::parser::parse_line;

#[test]
fn subagent_run_parses_expected_event_kinds() {
    let raw = include_str!("fixtures/subagent-run.jsonl");
    let events: Vec<ClaudeEvent> = raw.lines().flat_map(parse_line).collect();

    let spawns = events
        .iter()
        .filter(|e| matches!(e, ClaudeEvent::SubagentSpawn { .. }))
        .count();
    assert_eq!(spawns, 1, "exactly one subagent spawn");

    let file_calls = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                ClaudeEvent::ToolCall {
                    file_path: Some(_),
                    ..
                }
            )
        })
        .count();
    assert!(
        file_calls >= 2,
        "at least two file tool calls (read + edit)"
    );

    assert!(events.iter().any(|e| matches!(e,
        ClaudeEvent::ToolResult { tool_use_id, parent_tool_use_id: None, .. } if tool_use_id == "toolu_agent1")),
        "agent completion result present, attributed to master");

    assert!(
        events.iter().any(|e| matches!(e,
        ClaudeEvent::ToolCall { parent_tool_use_id: Some(p), .. } if p == "toolu_agent1")),
        "file call attributed to subagent"
    );
}
