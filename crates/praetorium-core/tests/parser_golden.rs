// Integration test: feed a real captured session through parse_line and assert
// that (a) no line panics, (b) we end on a Result, (c) at least one AssistantText appears.
use praetorium_core::events::ClaudeEvent;
use praetorium_core::parser::parse_line;

#[test]
fn real_session_parses_without_panic_and_terminates_in_result() {
    let raw = include_str!("fixtures/sample-run.jsonl");
    let events: Vec<ClaudeEvent> = raw.lines().flat_map(parse_line).collect();

    assert!(!events.is_empty(), "expected at least one parsed event");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ClaudeEvent::AssistantText { .. })),
        "expected at least one assistant text event"
    );
    assert!(
        matches!(events.last(), Some(ClaudeEvent::Result { .. })),
        "expected the stream to end in a Result event"
    );
}
