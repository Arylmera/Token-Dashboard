//! Time one full `scan_dir` pass against a copy of the live DB and report
//! the result (or the error that aborts it). Companion to `perf_probe`,
//! which times the read path; this one times ingest.
//!
//! Never point it at `~/.claude/token-dashboard.db` — take a snapshot
//! (`sqlite3 .backup`, or Python's `Connection.backup`) and scan that.
use std::time::Instant;

fn main() {
    let db = std::env::args()
        .nth(1)
        .expect("usage: scan_probe <db> <projects_dir>");
    let dir = std::env::args()
        .nth(2)
        .expect("usage: scan_probe <db> <projects_dir>");
    // Same order as the app: schema/migrations first, then the scan.
    token_dashboard_core::init_db(&db).expect("init_db");
    let t = Instant::now();
    let out = token_dashboard_core::scan_dir(&dir, &db);
    println!("elapsed {:?}", t.elapsed());
    match out {
        Ok(s) => println!(
            "ok: files={} messages={} tools={}",
            s.files, s.messages, s.tools
        ),
        Err(e) => println!("ERR: {e}"),
    }
}
