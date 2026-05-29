use praetorium_core::sessions::line_to_turn;

#[test]
fn skips_noise_and_extracts_turns() {
    let raw = include_str!("fixtures/session-sample.jsonl");
    let turns: Vec<_> = raw.lines().filter_map(line_to_turn).collect();
    assert!(
        !turns.is_empty(),
        "expected at least one conversational turn"
    );
    assert!(turns
        .iter()
        .all(|t| t.role == "user" || t.role == "assistant"));
    assert!(turns.iter().all(|t| !t.text.is_empty()));
    assert!(turns
        .iter()
        .all(|t| !t.text.contains("local-command-caveat")));
}
