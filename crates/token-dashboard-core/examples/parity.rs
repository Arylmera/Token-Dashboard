//! Parity binary — compares row counts and aggregate token totals
//! between the 3.x Python-scanned DB and the 4.0 Rust-scanned DB.
//!
//! Usage:
//!   1. Run 3.x scan against your projects tree:
//!      `python3 cli.py scan`
//!      copy the resulting `~/.claude/token-dashboard.db` to
//!      `/tmp/td-py.db`.
//!   2. Run the Rust scanner into a fresh DB:
//!      `cargo run --example parity -- --rust-init <PROJECTS_ROOT> /tmp/td-rs.db`
//!   3. Diff:
//!      `cargo run --example parity -- /tmp/td-py.db /tmp/td-rs.db`
//!
//! Permanent CI gate per plan §R2 mitigation. The fixture transcript tree
//! lives in `tests/fixtures/parity/` (deferred to a follow-up commit; this
//! binary is the consumer side, ready before the fixtures land).

use std::env;
use std::process::ExitCode;

use rusqlite::Connection;
use token_dashboard_core::scan_dir;

#[derive(Debug, PartialEq, Eq)]
struct Aggregates {
    messages: i64,
    tool_calls: i64,
    files: i64,
    sum_input_tokens: i64,
    sum_output_tokens: i64,
    sum_cache_read_tokens: i64,
    sum_cache_create_5m_tokens: i64,
    sum_cache_create_1h_tokens: i64,
}

fn aggregates(db: &str) -> rusqlite::Result<Aggregates> {
    let c = Connection::open(db)?;
    let messages: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
    let tool_calls: i64 = c.query_row("SELECT COUNT(*) FROM tool_calls", [], |r| r.get(0))?;
    let files: i64 = c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    let sum_input: i64 = c.query_row(
        "SELECT COALESCE(SUM(input_tokens),0) FROM messages",
        [],
        |r| r.get(0),
    )?;
    let sum_output: i64 = c.query_row(
        "SELECT COALESCE(SUM(output_tokens),0) FROM messages",
        [],
        |r| r.get(0),
    )?;
    let sum_cr: i64 = c.query_row(
        "SELECT COALESCE(SUM(cache_read_tokens),0) FROM messages",
        [],
        |r| r.get(0),
    )?;
    let sum_5m: i64 = c.query_row(
        "SELECT COALESCE(SUM(cache_create_5m_tokens),0) FROM messages",
        [],
        |r| r.get(0),
    )?;
    let sum_1h: i64 = c.query_row(
        "SELECT COALESCE(SUM(cache_create_1h_tokens),0) FROM messages",
        [],
        |r| r.get(0),
    )?;
    Ok(Aggregates {
        messages,
        tool_calls,
        files,
        sum_input_tokens: sum_input,
        sum_output_tokens: sum_output,
        sum_cache_read_tokens: sum_cr,
        sum_cache_create_5m_tokens: sum_5m,
        sum_cache_create_1h_tokens: sum_1h,
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [flag, projects_root, out_db] if flag == "--rust-init" => {
            match scan_dir(projects_root, out_db) {
                Ok(stats) => {
                    eprintln!(
                        "rust scan: {} files, {} messages, {} tools",
                        stats.files, stats.messages, stats.tools
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("scan failed: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        [py_db, rs_db] => {
            let py = match aggregates(py_db) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("could not read python db {py_db}: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let rs = match aggregates(rs_db) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("could not read rust db {rs_db}: {e}");
                    return ExitCode::FAILURE;
                }
            };
            if py == rs {
                println!("PARITY OK\n  {py:#?}");
                ExitCode::SUCCESS
            } else {
                eprintln!("PARITY DRIFT\n  python: {py:#?}\n  rust:   {rs:#?}");
                ExitCode::FAILURE
            }
        }
        _ => {
            eprintln!(
                "usage: parity <python.db> <rust.db>\n   or: parity --rust-init <PROJECTS_ROOT> <out.db>"
            );
            ExitCode::FAILURE
        }
    }
}
