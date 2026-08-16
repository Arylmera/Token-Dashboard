//! Filesystem-driven scan trigger.
//!
//! The periodic loop in `scan.rs` bounds staleness to one tick (10s); this
//! watcher collapses it to the debounce window by reacting to writes in
//! `~/.claude/projects` as they land. Claude Code appends to the active
//! session's `.jsonl` on every turn, so a prompt reaching the dashboard no
//! longer waits on the next tick. The poll loop stays as the safety net —
//! `notify` degrades to polling on some filesystems (network shares, WSL
//! mounts) and can miss events entirely there.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::Notify;

use crate::scan::run_scan_and_broadcast;
use crate::state::AppState;

/// Coalesce window. A single turn writes several lines in quick
/// succession; waiting a beat turns that burst into one scan.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(400);

fn is_transcript(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("jsonl")
}

/// Watch `state.projects_dir` recursively and run a scan `debounce` after
/// a transcript write settles. Returns `Err` when the watcher can't be
/// installed (missing directory, exhausted OS handles) — callers treat
/// that as non-fatal and lean on the poll loop.
///
/// The watcher is moved into the spawned task so it lives as long as the
/// process; dropping a `RecommendedWatcher` unregisters it.
pub fn spawn_scan_watcher(state: AppState, debounce: Duration) -> Result<(), String> {
    let root = state.projects_dir.as_ref().clone();
    let signal = Arc::new(Notify::new());
    let tx = signal.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_))
                && ev.paths.iter().any(|p| is_transcript(p))
            {
                // Sync + non-blocking: safe to call from notify's own thread.
                tx.notify_one();
            }
        }
    })
    .map_err(|e| format!("watcher: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", root.display()))?;

    tokio::spawn(async move {
        let _watcher = watcher; // keep alive for the life of the task
        loop {
            signal.notified().await;
            // Writes arriving during the sleep re-arm the permit, so a long
            // burst costs one extra scan after it ends. That scan ingests
            // nothing and stays silent on the bus — cheaper than tracking
            // the burst.
            tokio::time::sleep(debounce).await;
            // A scan already running will read the bytes this write added
            // (it reads each file to EOF), so queueing another behind it
            // buys nothing and, on a large history where a pass takes tens
            // of seconds, would keep a busy session scanning back to back.
            // The poll loop is the backstop for anything landing late.
            if state.scan_lock.try_lock().is_err() {
                continue;
            }
            if let Err(e) = run_scan_and_broadcast(state.clone()).await {
                tracing::warn!(error = %e, "watch-triggered scan failed");
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A transcript write must land in the database without any poll tick
    /// firing — the whole point of the watcher.
    #[tokio::test]
    async fn write_triggers_scan() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = tmp.path().join("t.db");
        let projects = tmp.path().join("projects");
        let proj = projects.join("C--work-sample");
        std::fs::create_dir_all(&proj).unwrap();
        token_dashboard_core::init_db(&db).unwrap();

        let state = AppState::new(
            db.clone(),
            token_dashboard_core::Pricing::embedded(),
            projects.clone(),
        );
        let mut rx = state.events.subscribe();
        spawn_scan_watcher(state, Duration::from_millis(50)).unwrap();

        let mut f = std::fs::File::create(proj.join("s1.jsonl")).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","uuid":"a1","sessionId":"s1","timestamp":"2026-05-12T10:00:00Z","isSidechain":false,"message":{{"id":"m1","model":"claude-opus-4-7","content":[],"usage":{{"input_tokens":10,"output_tokens":5}}}}}}"#
        )
        .unwrap();
        f.flush().unwrap();
        drop(f);

        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("watcher must scan without a poll tick")
            .expect("bus alive");
        assert_eq!(ev["type"], "scan_complete");
        assert_eq!(ev["messages"], 1);
    }
}
