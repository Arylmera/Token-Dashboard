//! JSONL transcript walker + parser.
//!
//! Direct port of `token_dashboard/scanner.py`. Semantics that *must* hold:
//!
//! - `(session_id, message_id)` is the dedup key, not `uuid` (CLAUDE.md).
//! - High-water mark is the byte offset of the *last fully-parsed* line, so
//!   a partial line mid-flush is retried on the next scan.
//! - `INSERT OR REPLACE` on `messages` by `uuid`; `tool_calls` cleared by
//!   `message_uuid` before reinsert so rescans are idempotent.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{named_params, Connection};
use serde_json::Value;
use walkdir::WalkDir;

const INSERT_MSG: &str = r#"
INSERT OR REPLACE INTO messages (
  uuid, parent_uuid, session_id, project_slug, cwd, git_branch, cc_version, entrypoint,
  type, is_sidechain, agent_id, timestamp, model, stop_reason, prompt_id, message_id,
  input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
  prompt_text, prompt_chars, tool_calls_json
) VALUES (
  :uuid, :parent_uuid, :session_id, :project_slug, :cwd, :git_branch, :cc_version, :entrypoint,
  :type, :is_sidechain, :agent_id, :timestamp, :model, :stop_reason, :prompt_id, :message_id,
  :input_tokens, :output_tokens, :cache_read_tokens, :cache_create_5m_tokens, :cache_create_1h_tokens,
  :prompt_text, :prompt_chars, :tool_calls_json
)
"#;

const INSERT_TOOL: &str = r#"
INSERT INTO tool_calls (
  message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp
) VALUES (
  :message_uuid, :session_id, :project_slug, :tool_name, :target, :use_id, :result_tokens, :is_error, :timestamp
)
"#;

#[derive(Debug, Clone, Default)]
pub struct ScanStats {
    pub messages: u64,
    pub tools: u64,
    pub files: u64,
    pub sessions: Vec<String>,
    pub projects: Vec<String>,
    pub days: Vec<String>,
    pub models: Vec<String>,
    pub min_ts: Option<String>,
    pub max_ts: Option<String>,
}

#[derive(Debug, Default)]
struct FileScan {
    messages: u64,
    tools: u64,
    end_offset: u64,
    sessions: BTreeSet<String>,
    models: BTreeSet<String>,
    days: BTreeSet<String>,
    min_ts: Option<String>,
    max_ts: Option<String>,
}

fn target_field(name: &str) -> Option<&'static str> {
    match name {
        "Read" | "Edit" | "Write" => Some("file_path"),
        "Glob" | "Grep" => Some("pattern"),
        "Bash" => Some("command"),
        "WebFetch" => Some("url"),
        "WebSearch" => Some("query"),
        "Task" => Some("subagent_type"),
        "Skill" => Some("skill"),
        _ => None,
    }
}

fn truncate_500(s: &str) -> String {
    // Python `s[:500]` slices by Unicode chars (Python 3 strings). Match
    // that, not byte-slice — emoji-heavy bash commands would diverge.
    s.chars().take(500).collect()
}

fn target_for(name: &str, input: &Value) -> Option<String> {
    let field = target_field(name)?;
    let v = input.get(field)?.as_str()?;
    Some(truncate_500(v))
}

fn usage_int(rec: &Value, key: &str) -> i64 {
    rec.get("message")
        .and_then(|m| m.get("usage"))
        .and_then(|u| u.get(key))
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

fn cache_create_int(rec: &Value, key: &str) -> i64 {
    rec.get("message")
        .and_then(|m| m.get("usage"))
        .and_then(|u| u.get("cache_creation"))
        .and_then(|c| c.get(key))
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

fn char_count(s: &str) -> i64 {
    // Python `len(str)` counts Unicode codepoints. Rust `s.len()` is bytes.
    // Match Python so prompt_chars is comparable across the two scanners.
    s.chars().count() as i64
}

fn prompt_text(rec: &Value) -> (Option<String>, Option<i64>) {
    if rec.get("type").and_then(|t| t.as_str()) != Some("user") {
        return (None, None);
    }
    let content = match rec.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return (None, None),
    };
    if let Some(s) = content.as_str() {
        // Python: `return content, len(content)` — empty string yields ("", 0).
        return (Some(s.to_string()), Some(char_count(s)));
    }
    if let Some(arr) = content.as_array() {
        // Python:
        //   parts = [b.get("text","") for b in content if b.type == "text"]
        //   text  = "".join(parts) if parts else None
        //   return text, (len(text) if text else None)
        // i.e. (None, None) when no text blocks; ("", None) when blocks join
        // to empty; (joined, len(joined)) otherwise. The `("", None)` case
        // is reproduced by tracking `had_text_block` separately.
        let mut had_text_block = false;
        let mut joined = String::new();
        for b in arr {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                had_text_block = true;
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    joined.push_str(t);
                }
            }
        }
        if !had_text_block {
            return (None, None);
        }
        let chars = if joined.is_empty() {
            None
        } else {
            Some(char_count(&joined))
        };
        return (Some(joined), chars);
    }
    (None, None)
}

#[derive(Debug)]
struct ToolRow {
    tool_name: String,
    target: Option<String>,
    use_id: Option<String>,
    result_tokens: Option<i64>,
    is_error: i64,
    timestamp: Option<String>,
    message_uuid: String,
    session_id: String,
    project_slug: String,
}

/// `(tool_name, target, use_id, result_tokens, is_error)` — minimal carrier
/// between the JSONL extraction step and the row-build step.
type ToolTuple = (String, Option<String>, Option<String>, Option<i64>, i64);

fn extract_tools(rec: &Value) -> Vec<ToolTuple> {
    let mut out = Vec::new();
    let arr = match rec
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(a) => a,
        None => return out,
    };
    for block in arr {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let name = block
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("unknown")
            .to_string();
        let empty = Value::Object(serde_json::Map::new());
        let input = block.get("input").unwrap_or(&empty);
        let target = target_for(&name, input);
        let use_id = block.get("id").and_then(|v| v.as_str()).map(String::from);
        out.push((name, target, use_id, None, 0));
    }
    out
}

fn extract_results(rec: &Value) -> Vec<ToolTuple> {
    let mut out = Vec::new();
    let arr = match rec
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(a) => a,
        None => return out,
    };
    for block in arr {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let body = block.get("content");
        let chars: i64 = match body {
            Some(v) if v.is_string() => v.as_str().map(char_count).unwrap_or(0),
            Some(v) if v.is_array() => v
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    p.get("text")
                        .and_then(|t| t.as_str())
                        .map(char_count)
                        .unwrap_or(0)
                })
                .sum(),
            _ => 0,
        };
        let tu = block
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let is_error = if block
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            1
        } else {
            0
        };
        out.push((
            "_tool_result".to_string(),
            tu.clone(),
            tu,
            Some(chars / 4),
            is_error,
        ));
    }
    out
}

fn ingest_record(
    conn: &Connection,
    rec: &Value,
    project_slug: &str,
) -> rusqlite::Result<Option<IngestSummary>> {
    let uuid = match rec.get("uuid").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };
    let r#type = match rec.get("type").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };
    let session_id = match rec.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };
    let timestamp = match rec.get("timestamp").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };

    let parent_uuid = rec
        .get("parentUuid")
        .and_then(|v| v.as_str())
        .map(String::from);
    let cwd = rec.get("cwd").and_then(|v| v.as_str()).map(String::from);
    let git_branch = rec
        .get("gitBranch")
        .and_then(|v| v.as_str())
        .map(String::from);
    let cc_version = rec
        .get("version")
        .and_then(|v| v.as_str())
        .map(String::from);
    let entrypoint = rec
        .get("entrypoint")
        .and_then(|v| v.as_str())
        .map(String::from);
    let is_sidechain = if rec
        .get("isSidechain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        1
    } else {
        0
    };
    let agent_id = rec
        .get("agentId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let model = rec
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let stop_reason = rec
        .get("message")
        .and_then(|m| m.get("stop_reason"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let prompt_id = rec
        .get("promptId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let message_id = rec
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let (text, chars) = prompt_text(rec);

    let input_tokens = usage_int(rec, "input_tokens");
    let output_tokens = usage_int(rec, "output_tokens");
    let cache_read_tokens = usage_int(rec, "cache_read_input_tokens");
    let cache_create_5m_tokens = cache_create_int(rec, "ephemeral_5m_input_tokens");
    let cache_create_1h_tokens = cache_create_int(rec, "ephemeral_1h_input_tokens");

    let mut tools = extract_tools(rec);
    tools.extend(extract_results(rec));

    let tool_calls_json = if tools.is_empty() {
        None
    } else {
        let summary: Vec<Value> = tools
            .iter()
            .filter(|t| t.0 != "_tool_result")
            .map(|t| {
                let mut o = serde_json::Map::new();
                o.insert("name".into(), Value::String(t.0.clone()));
                o.insert(
                    "target".into(),
                    match &t.1 {
                        Some(s) => Value::String(s.clone()),
                        None => Value::Null,
                    },
                );
                Value::Object(o)
            })
            .collect();
        Some(serde_json::to_string(&summary).unwrap_or_else(|_| "[]".into()))
    };

    if let Some(mid) = message_id.as_deref() {
        evict_prior_snapshots(conn, &session_id, mid, &uuid)?;
    }

    conn.execute(
        INSERT_MSG,
        named_params! {
            ":uuid": uuid,
            ":parent_uuid": parent_uuid,
            ":session_id": session_id,
            ":project_slug": project_slug,
            ":cwd": cwd,
            ":git_branch": git_branch,
            ":cc_version": cc_version,
            ":entrypoint": entrypoint,
            ":type": r#type,
            ":is_sidechain": is_sidechain,
            ":agent_id": agent_id,
            ":timestamp": timestamp,
            ":model": model,
            ":stop_reason": stop_reason,
            ":prompt_id": prompt_id,
            ":message_id": message_id,
            ":input_tokens": input_tokens,
            ":output_tokens": output_tokens,
            ":cache_read_tokens": cache_read_tokens,
            ":cache_create_5m_tokens": cache_create_5m_tokens,
            ":cache_create_1h_tokens": cache_create_1h_tokens,
            ":prompt_text": text,
            ":prompt_chars": chars,
            ":tool_calls_json": tool_calls_json,
        },
    )?;

    // tool_calls has no natural unique key; clear any prior rows for this
    // uuid so full rescans stay idempotent instead of duplicating rows.
    conn.execute("DELETE FROM tool_calls WHERE message_uuid=?", [&uuid])?;

    let mut tool_count: u64 = 0;
    for (tool_name, target, use_id, result_tokens, is_error) in tools {
        let row = ToolRow {
            tool_name,
            target,
            use_id,
            result_tokens,
            is_error,
            timestamp: Some(timestamp.clone()),
            message_uuid: uuid.clone(),
            session_id: session_id.clone(),
            project_slug: project_slug.to_string(),
        };
        conn.execute(
            INSERT_TOOL,
            named_params! {
                ":message_uuid": row.message_uuid,
                ":session_id": row.session_id,
                ":project_slug": row.project_slug,
                ":tool_name": row.tool_name,
                ":target": row.target,
                ":use_id": row.use_id,
                ":result_tokens": row.result_tokens,
                ":is_error": row.is_error,
                ":timestamp": row.timestamp,
            },
        )?;
        tool_count += 1;
    }

    Ok(Some(IngestSummary {
        session_id,
        timestamp,
        model,
        tool_count,
    }))
}

struct IngestSummary {
    session_id: String,
    timestamp: String,
    model: Option<String>,
    tool_count: u64,
}

/// Remove older streaming snapshots for the same `(session_id, message_id)`.
///
/// Claude Code writes 2–3 JSONL lines per assistant response (partial → final)
/// with identical `message.id` but distinct top-level uuids. Only the final
/// tally matches billing, so earlier snapshots must be replaced, not summed.
fn evict_prior_snapshots(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
    keep_uuid: &str,
) -> rusqlite::Result<()> {
    let mut stmt =
        conn.prepare("SELECT uuid FROM messages WHERE session_id=? AND message_id=? AND uuid!=?")?;
    let uuids: Vec<String> = stmt
        .query_map([session_id, message_id, keep_uuid], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    if uuids.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; uuids.len()].join(",");
    let del_tools = format!("DELETE FROM tool_calls WHERE message_uuid IN ({placeholders})");
    let del_msgs = format!("DELETE FROM messages WHERE uuid IN ({placeholders})");
    conn.execute(&del_tools, rusqlite::params_from_iter(uuids.iter()))?;
    conn.execute(&del_msgs, rusqlite::params_from_iter(uuids.iter()))?;
    Ok(())
}

/// Ingest new lines from a JSONL file starting at `start_byte`.
///
/// Returns counts plus `end_offset` — the byte offset just past the last
/// fully-parsed line. Callers persist `end_offset` as the file's
/// high-water mark so a line partially flushed at EOF gets re-read once
/// it completes.
pub fn scan_file(
    path: &Path,
    project_slug: &str,
    conn: &Connection,
    start_byte: u64,
) -> rusqlite::Result<FileScanPublic> {
    let mut sub = FileScan {
        end_offset: start_byte,
        ..Default::default()
    };

    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(sub.into()),
    };
    let mut reader = BufReader::new(f);
    if start_byte > 0 {
        reader.seek(SeekFrom::Start(start_byte)).map_err(io_err)?;
    }
    let mut pos = start_byte;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).map_err(io_err)?;
        if n == 0 {
            break; // EOF
        }
        if !buf.ends_with(b"\n") {
            // Partial line — Claude Code is mid-flush. Leave the
            // high-water mark behind the line start so we re-read it
            // once the write completes.
            break;
        }
        let line_end = pos + n as u64;
        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            sub.end_offset = line_end;
            pos = line_end;
            continue;
        }
        let rec: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                sub.end_offset = line_end;
                pos = line_end;
                continue;
            }
        };
        if !rec.is_object() || rec.get("uuid").is_none() || rec.get("type").is_none() {
            sub.end_offset = line_end;
            pos = line_end;
            continue;
        }
        match ingest_record(conn, &rec, project_slug)? {
            Some(summary) => {
                sub.messages += 1;
                sub.tools += summary.tool_count;
                sub.sessions.insert(summary.session_id.clone());
                if let Some(m) = summary.model {
                    sub.models.insert(m);
                }
                let ts = summary.timestamp;
                if ts.len() >= 10 {
                    sub.days.insert(ts[..10].to_string());
                }
                if sub.min_ts.as_deref().is_none_or(|m| ts.as_str() < m) {
                    sub.min_ts = Some(ts.clone());
                }
                if sub.max_ts.as_deref().is_none_or(|m| ts.as_str() > m) {
                    sub.max_ts = Some(ts);
                }
            }
            None => { /* missing required field — skip silently */ }
        }
        sub.end_offset = line_end;
        pos = line_end;
    }
    Ok(sub.into())
}

fn io_err(e: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

#[derive(Debug, Default)]
pub struct FileScanPublic {
    pub messages: u64,
    pub tools: u64,
    pub end_offset: u64,
    pub sessions: Vec<String>,
    pub models: Vec<String>,
    pub days: Vec<String>,
    pub min_ts: Option<String>,
    pub max_ts: Option<String>,
}

impl From<FileScan> for FileScanPublic {
    fn from(s: FileScan) -> Self {
        FileScanPublic {
            messages: s.messages,
            tools: s.tools,
            end_offset: s.end_offset,
            sessions: s.sessions.into_iter().collect(),
            models: s.models.into_iter().collect(),
            days: s.days.into_iter().collect(),
            min_ts: s.min_ts,
            max_ts: s.max_ts,
        }
    }
}

fn project_slug(file_path: &Path, projects_root: &Path) -> Option<String> {
    let rel = file_path.strip_prefix(projects_root).ok()?;
    let first = rel.components().next()?;
    Some(first.as_os_str().to_string_lossy().into_owned())
}

pub(crate) fn now_secs_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn mtime_f64(path: &Path) -> Option<f64> {
    let m = std::fs::metadata(path).ok()?;
    let mt = m.modified().ok()?;
    mt.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64())
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

pub fn scan_dir<P: AsRef<Path>, Q: AsRef<Path>>(
    projects_root: P,
    db_path: Q,
) -> rusqlite::Result<ScanStats> {
    let root = projects_root.as_ref().to_path_buf();
    let mut totals = TotalsAcc::default();
    if !root.is_dir() {
        return Ok(totals.finalize());
    }
    let conn = crate::db::open(db_path.as_ref())?;
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
    {
        let path: PathBuf = entry.path().to_path_buf();
        let mtime = match mtime_f64(&path) {
            Some(m) => m,
            None => continue,
        };
        let size = match file_size(&path) {
            Some(s) => s,
            None => continue,
        };

        let path_s = path.to_string_lossy().into_owned();
        let row: Option<(f64, i64)> = conn
            .query_row(
                "SELECT mtime, bytes_read FROM files WHERE path=?",
                [&path_s],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let mut offset: u64 = 0;
        if let Some((m, b)) = row {
            // SAFETY: mtime equality and size==bytes_read implies fully
            // ingested, identical file → skip.
            if m == mtime && (b as u64) == size {
                continue;
            }
            if size > b as u64 {
                offset = b as u64;
            }
        }

        let slug = match project_slug(&path, &root) {
            Some(s) => s,
            None => continue,
        };
        let sub = scan_file(&path, &slug, &conn, offset)?;

        // Persist the byte offset of the last fully-parsed line (not
        // st_size) so a partial line mid-flush is retried on the next
        // scan instead of being skipped over.
        conn.execute(
            "INSERT OR REPLACE INTO files (path, mtime, bytes_read, scanned_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![path_s, mtime, sub.end_offset as i64, now_secs_f64()],
        )?;

        totals.messages += sub.messages;
        totals.tools += sub.tools;
        totals.files += 1;

        // Only mark this project as changed if the file produced new rows.
        if !sub.sessions.is_empty() {
            for s in sub.sessions {
                totals.sessions.insert(s);
            }
            totals.projects.insert(slug);
            for d in sub.days {
                totals.days.insert(d);
            }
            for m in sub.models {
                totals.models.insert(m);
            }
            if let Some(t) = sub.min_ts {
                if totals.min_ts.as_deref().is_none_or(|m| t.as_str() < m) {
                    totals.min_ts = Some(t);
                }
            }
            if let Some(t) = sub.max_ts {
                if totals.max_ts.as_deref().is_none_or(|m| t.as_str() > m) {
                    totals.max_ts = Some(t);
                }
            }
        }
    }
    // Backfill auto-tags for any session in `messages` that hasn't been
    // logged yet. SQL-side filter means the first scan stamps every
    // historic git project; subsequent scans skip the already-tagged
    // sessions in a single query. Best-effort — a failure here shouldn't
    // poison the scan stats.
    if let Err(e) = crate::auto_tags::backfill_all(&conn) {
        eprintln!("auto-tag: {e}");
    }

    // Refresh query-planner statistics when new rows landed. Stale/absent
    // stats make SQLite drive the tag aggregate from `messages` (a full
    // scan) instead of the small `session_tags` table. `analysis_limit`
    // caps sampling so this stays cheap on large tables; best-effort —
    // never fail a scan over planner stats.
    if totals.messages > 0 {
        if let Err(e) = conn.execute_batch("PRAGMA analysis_limit=400; PRAGMA optimize;") {
            eprintln!("optimize: {e}");
        }
    }

    Ok(totals.finalize())
}

#[derive(Default)]
struct TotalsAcc {
    messages: u64,
    tools: u64,
    files: u64,
    sessions: BTreeSet<String>,
    projects: BTreeSet<String>,
    days: BTreeSet<String>,
    models: BTreeSet<String>,
    min_ts: Option<String>,
    max_ts: Option<String>,
}

impl TotalsAcc {
    fn finalize(self) -> ScanStats {
        ScanStats {
            messages: self.messages,
            tools: self.tools,
            files: self.files,
            sessions: self.sessions.into_iter().collect(),
            projects: self.projects.into_iter().collect(),
            days: self.days.into_iter().collect(),
            models: self.models.into_iter().collect(),
            min_ts: self.min_ts,
            max_ts: self.max_ts,
        }
    }
}
