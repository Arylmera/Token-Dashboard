//! OpenAI Codex CLI provider.
//!
//! Walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and projects the
//! Codex rollout schema onto the same `messages` / `tool_calls` / `files`
//! tables used by the Claude provider. The full field map and state
//! machine are spelled out in [`docs/CODEX_PROVIDER.md`].

use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{named_params, Connection};
use serde_json::Value;
use walkdir::WalkDir;

use super::{Provider, ScanOpts, ScanReport};

const INSERT_MSG: &str = r#"
INSERT OR REPLACE INTO messages (
  uuid, parent_uuid, session_id, project_slug, cwd, git_branch, cc_version, entrypoint,
  type, is_sidechain, agent_id, timestamp, model, stop_reason, prompt_id, message_id,
  input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
  prompt_text, prompt_chars, tool_calls_json, provider
) VALUES (
  :uuid, :parent_uuid, :session_id, :project_slug, :cwd, :git_branch, :cc_version, :entrypoint,
  :type, :is_sidechain, :agent_id, :timestamp, :model, :stop_reason, :prompt_id, :message_id,
  :input_tokens, :output_tokens, :cache_read_tokens, :cache_create_5m_tokens, :cache_create_1h_tokens,
  :prompt_text, :prompt_chars, :tool_calls_json, 'codex'
)
"#;

const INSERT_TOOL: &str = r#"
INSERT INTO tool_calls (
  message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp, provider
) VALUES (
  :message_uuid, :session_id, :project_slug, :tool_name, :target, :use_id, :result_tokens, :is_error, :timestamp, 'codex'
)
"#;

/// Codex CLI provider. Reads `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`.
pub struct Codex;

impl Codex {
    fn resolve_root(&self, opts: &ScanOpts) -> PathBuf {
        if let Some(root) = opts.root_override.as_ref() {
            return root.clone();
        }
        if let Some(env) = std::env::var_os("CODEX_SESSIONS_DIR") {
            return PathBuf::from(env);
        }
        self.default_root()
            .unwrap_or_else(|| PathBuf::from(".codex/sessions"))
    }
}

impl Provider for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "OpenAI Codex"
    }

    fn default_root(&self) -> Option<PathBuf> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)?;
        Some(home.join(".codex").join("sessions"))
    }

    fn scan(&self, opts: &ScanOpts) -> rusqlite::Result<ScanReport> {
        let root = self.resolve_root(opts);
        let mut report = ScanReport {
            provider: self.id(),
            ..Default::default()
        };
        if !root.is_dir() {
            return Ok(report);
        }
        let conn = crate::db::open(&opts.db_path)?;
        let mut totals = Totals::default();
        for entry in WalkDir::new(&root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        {
            let path = entry.path().to_path_buf();
            let Some(mtime) = mtime_secs(&path) else {
                continue;
            };
            let Some(size) = file_size(&path) else {
                continue;
            };

            let path_s = path.to_string_lossy().into_owned();
            let prior: Option<(f64, i64)> = conn
                .query_row(
                    "SELECT mtime, bytes_read FROM files WHERE path=?",
                    [&path_s],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            if let Some((m, b)) = prior {
                if m == mtime && (b as u64) == size {
                    continue;
                }
            }

            // Codex always rescans from byte 0: the state machine needs
            // session_meta + turn_context history to attribute model and
            // parents correctly. Idempotency is preserved via the
            // synthesized `cdx-<session>-<line_no>` uuid + INSERT OR REPLACE.
            // scan_file returns None when the file lacks `session_meta` —
            // could be a foreign JSONL (e.g. a Claude fixture under a
            // shared root_override). Skip the files watermark too so the
            // path isn't claimed as codex on disk.
            let Some(sub) = scan_file(&path, &conn)? else {
                continue;
            };
            conn.execute(
                "INSERT OR REPLACE INTO files (path, mtime, bytes_read, scanned_at, provider) VALUES (?, ?, ?, ?, 'codex')",
                rusqlite::params![path_s, mtime, size as i64, now_secs()],
            )?;
            totals.absorb(sub);
            totals.files += 1;
        }
        totals.fill(&mut report);
        Ok(report)
    }
}

#[derive(Default)]
struct Totals {
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

impl Totals {
    fn absorb(&mut self, s: FileScan) {
        self.messages += s.messages;
        self.tools += s.tools;
        self.sessions.extend(s.sessions);
        self.projects.extend(s.projects);
        self.days.extend(s.days);
        self.models.extend(s.models);
        if let Some(t) = s.min_ts {
            if self.min_ts.as_deref().is_none_or(|m| t.as_str() < m) {
                self.min_ts = Some(t);
            }
        }
        if let Some(t) = s.max_ts {
            if self.max_ts.as_deref().is_none_or(|m| t.as_str() > m) {
                self.max_ts = Some(t);
            }
        }
    }

    fn fill(self, r: &mut ScanReport) {
        r.messages = self.messages;
        r.tools = self.tools;
        r.files = self.files;
        r.sessions = self.sessions.into_iter().collect();
        r.projects = self.projects.into_iter().collect();
        r.days = self.days.into_iter().collect();
        r.models = self.models.into_iter().collect();
        r.min_ts = self.min_ts;
        r.max_ts = self.max_ts;
    }
}

#[derive(Default)]
struct FileScan {
    messages: u64,
    tools: u64,
    sessions: BTreeSet<String>,
    projects: BTreeSet<String>,
    days: BTreeSet<String>,
    models: BTreeSet<String>,
    min_ts: Option<String>,
    max_ts: Option<String>,
}

#[derive(Default, Clone)]
struct Usage {
    input: i64,
    cached: i64,
    output: i64,
    reasoning: i64,
}

#[derive(Default)]
struct SessionState {
    session_id: String,
    project_slug: String,
    cwd: String,
    cli_version: Option<String>,
    git_branch: Option<String>,
    current_model: Option<String>,
    user_parents: HashMap<String, String>,
    last_usage: HashMap<String, Usage>,
    pending_calls: HashMap<String, String>,
    last_assistant: Option<String>,
    line_no: u64,
}

fn scan_file(path: &Path, conn: &Connection) -> rusqlite::Result<Option<FileScan>> {
    let mut sub = FileScan::default();
    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    let mut reader = BufReader::new(f);
    let mut state = SessionState::default();
    if let Some(fallback) = filename_session_id(path) {
        state.session_id = fallback;
    }
    let mut saw_session_meta = false;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).map_err(io_err)?;
        if n == 0 {
            break;
        }
        if !buf.ends_with(b"\n") {
            // Partial line at EOF — Codex is mid-flush. Stop here; the
            // next scan will start over from byte 0 once mtime/size change.
            break;
        }
        state.line_no += 1;
        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if rec.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
            saw_session_meta = true;
        }
        process_line(conn, &rec, &mut state, &mut sub)?;
    }
    if saw_session_meta {
        Ok(Some(sub))
    } else {
        Ok(None)
    }
}

fn process_line(
    conn: &Connection,
    rec: &Value,
    state: &mut SessionState,
    sub: &mut FileScan,
) -> rusqlite::Result<()> {
    let timestamp = rec
        .get("timestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let rec_type = rec.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let payload = match rec.get("payload") {
        Some(p) => p,
        None => return Ok(()),
    };

    match rec_type {
        "session_meta" => {
            if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                state.session_id = id.to_string();
            }
            if let Some(cwd) = payload.get("cwd").and_then(|v| v.as_str()) {
                state.cwd = cwd.to_string();
                state.project_slug = slug_from_cwd(cwd);
            }
            state.cli_version = payload
                .get("cli_version")
                .and_then(|v| v.as_str())
                .map(String::from);
            state.git_branch = payload
                .get("git")
                .and_then(|g| g.get("branch"))
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        "turn_context" => {
            if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                state.current_model = Some(m.to_string());
            }
            if let Some(c) = payload.get("cwd").and_then(|v| v.as_str()) {
                state.cwd = c.to_string();
                state.project_slug = slug_from_cwd(c);
            }
        }
        "event_msg" => handle_event_msg(conn, payload, &timestamp, state, sub)?,
        "response_item" => handle_response_item(conn, payload, &timestamp, state, sub)?,
        _ => {}
    }
    Ok(())
}

fn handle_event_msg(
    conn: &Connection,
    payload: &Value,
    timestamp: &str,
    state: &mut SessionState,
    sub: &mut FileScan,
) -> rusqlite::Result<()> {
    let pt = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let turn_id = payload
        .get("turn_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match pt {
        "token_count" => {
            if let Some(last) = payload
                .get("info")
                .and_then(|i| if i.is_null() { None } else { Some(i) })
                .and_then(|i| i.get("last_token_usage"))
            {
                let u = Usage {
                    input: i64_or_zero(last, "input_tokens"),
                    cached: i64_or_zero(last, "cached_input_tokens"),
                    output: i64_or_zero(last, "output_tokens"),
                    reasoning: i64_or_zero(last, "reasoning_output_tokens"),
                };
                state.last_usage.insert(turn_id, u);
            }
        }
        "user_message" => {
            let text = payload
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let uuid = synth_uuid(state);
            state.user_parents.insert(turn_id.clone(), uuid.clone());
            state.last_assistant = None;
            insert_message(
                conn,
                state,
                &uuid,
                None,
                "user",
                timestamp,
                None,
                Some(&text),
                None,
            )?;
            record_message(sub, state, timestamp, None);
        }
        "agent_message" => {
            let text = payload
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let uuid = synth_uuid(state);
            let parent = state.user_parents.get(&turn_id).cloned();
            let usage = state.last_usage.get(&turn_id).cloned().unwrap_or_default();
            let model = state.current_model.clone();
            insert_message(
                conn,
                state,
                &uuid,
                parent.as_deref(),
                "assistant",
                timestamp,
                model.as_deref(),
                Some(&text),
                Some(&usage),
            )?;
            state.last_assistant = Some(uuid);
            record_message(sub, state, timestamp, model.as_deref());
        }
        _ => {}
    }
    Ok(())
}

fn handle_response_item(
    conn: &Connection,
    payload: &Value,
    timestamp: &str,
    state: &mut SessionState,
    sub: &mut FileScan,
) -> rusqlite::Result<()> {
    let pt = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match pt {
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let call_id = payload
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = payload
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let target = target_from_args(&name, args);
            let parent_uuid = state
                .last_assistant
                .clone()
                .or_else(|| state.user_parents.values().next().cloned())
                .unwrap_or_default();
            if parent_uuid.is_empty() {
                return Ok(());
            }
            state
                .pending_calls
                .insert(call_id.clone(), parent_uuid.clone());
            insert_tool(
                conn,
                state,
                &parent_uuid,
                &name,
                target.as_deref(),
                Some(&call_id),
                None,
                0,
                timestamp,
            )?;
            sub.tools += 1;
        }
        "function_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let output = payload.get("output").and_then(|v| v.as_str()).unwrap_or("");
            let chars = output.chars().count() as i64;
            let is_error = if looks_like_error(output) { 1 } else { 0 };
            let Some(parent_uuid) = state.pending_calls.get(&call_id).cloned() else {
                return Ok(());
            };
            insert_tool(
                conn,
                state,
                &parent_uuid,
                "_tool_result",
                Some(&call_id),
                Some(&call_id),
                Some(chars / 4),
                is_error,
                timestamp,
            )?;
            sub.tools += 1;
        }
        _ => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    conn: &Connection,
    state: &SessionState,
    uuid: &str,
    parent_uuid: Option<&str>,
    msg_type: &str,
    timestamp: &str,
    model: Option<&str>,
    text: Option<&str>,
    usage: Option<&Usage>,
) -> rusqlite::Result<()> {
    let chars = text.map(|t| t.chars().count() as i64);
    let u = usage.cloned().unwrap_or_default();
    let cwd: Option<String> = if state.cwd.is_empty() {
        None
    } else {
        Some(state.cwd.clone())
    };
    conn.execute(
        INSERT_MSG,
        named_params! {
            ":uuid": uuid,
            ":parent_uuid": parent_uuid,
            ":session_id": state.session_id,
            ":project_slug": state.project_slug,
            ":cwd": cwd,
            ":git_branch": state.git_branch,
            ":cc_version": state.cli_version,
            ":entrypoint": Option::<String>::None,
            ":type": msg_type,
            ":is_sidechain": 0i64,
            ":agent_id": Option::<String>::None,
            ":timestamp": timestamp,
            ":model": model,
            ":stop_reason": Option::<String>::None,
            ":prompt_id": Option::<String>::None,
            ":message_id": Option::<String>::None,
            ":input_tokens": u.input,
            ":output_tokens": u.output + u.reasoning,
            ":cache_read_tokens": u.cached,
            ":cache_create_5m_tokens": 0i64,
            ":cache_create_1h_tokens": 0i64,
            ":prompt_text": if msg_type == "user" { text } else { None },
            ":prompt_chars": if msg_type == "user" { chars } else { None },
            ":tool_calls_json": Option::<String>::None,
        },
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_tool(
    conn: &Connection,
    state: &SessionState,
    message_uuid: &str,
    tool_name: &str,
    target: Option<&str>,
    use_id: Option<&str>,
    result_tokens: Option<i64>,
    is_error: i64,
    timestamp: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        INSERT_TOOL,
        named_params! {
            ":message_uuid": message_uuid,
            ":session_id": state.session_id,
            ":project_slug": state.project_slug,
            ":tool_name": tool_name,
            ":target": target,
            ":use_id": use_id,
            ":result_tokens": result_tokens,
            ":is_error": is_error,
            ":timestamp": timestamp,
        },
    )?;
    Ok(())
}

fn record_message(sub: &mut FileScan, state: &SessionState, ts: &str, model: Option<&str>) {
    sub.messages += 1;
    if !state.session_id.is_empty() {
        sub.sessions.insert(state.session_id.clone());
    }
    if !state.project_slug.is_empty() {
        sub.projects.insert(state.project_slug.clone());
    }
    if ts.len() >= 10 {
        sub.days.insert(ts[..10].to_string());
    }
    if let Some(m) = model {
        sub.models.insert(m.to_string());
    }
    if sub.min_ts.as_deref().is_none_or(|m| ts < m) {
        sub.min_ts = Some(ts.to_string());
    }
    if sub.max_ts.as_deref().is_none_or(|m| ts > m) {
        sub.max_ts = Some(ts.to_string());
    }
}

fn synth_uuid(state: &SessionState) -> String {
    format!("cdx-{}-{}", state.session_id, state.line_no)
}

fn slug_from_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        match c {
            ':' | '/' | '\\' => out.push('-'),
            x => out.push(x),
        }
    }
    out.trim_matches('-').to_string()
}

fn target_from_args(name: &str, args: &str) -> Option<String> {
    let v: Value = serde_json::from_str(args).ok()?;
    let key = match name {
        "shell" | "local_shell" | "bash" => "command",
        "apply_patch" => "input",
        "read_file" | "view" => "path",
        _ => return None,
    };
    let val = v.get(key)?;
    let raw = if let Some(s) = val.as_str() {
        s.to_string()
    } else if let Some(arr) = val.as_array() {
        arr.iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        return None;
    };
    Some(raw.chars().take(500).collect())
}

fn looks_like_error(output: &str) -> bool {
    output.contains("\"success\":false") || output.contains("\"error\":")
}

fn i64_or_zero(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn filename_session_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    // `rollout-2026-05-12T20-48-47-<uuid>` — keep the trailing 36 chars
    // if the stem is long enough, else use the whole stem.
    if stem.len() >= 36 {
        Some(stem[stem.len() - 36..].to_string())
    } else {
        Some(stem.to_string())
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn mtime_secs(path: &Path) -> Option<f64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64())
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

fn io_err(e: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_and_label_are_stable() {
        let c = Codex;
        assert_eq!(c.id(), "codex");
        assert_eq!(c.label(), "OpenAI Codex");
    }

    #[test]
    fn slug_strips_drive_and_separators() {
        assert_eq!(slug_from_cwd("C:\\Users\\g\\proj"), "C--Users-g-proj");
        assert_eq!(slug_from_cwd("/home/u/proj"), "home-u-proj");
    }

    #[test]
    fn target_extracts_shell_command_string() {
        let t = target_from_args("shell", r#"{"command":"ls -la"}"#);
        assert_eq!(t.as_deref(), Some("ls -la"));
    }

    #[test]
    fn target_joins_shell_command_array() {
        let t = target_from_args("local_shell", r#"{"command":["ls","-la"]}"#);
        assert_eq!(t.as_deref(), Some("ls -la"));
    }

    #[test]
    fn error_heuristic_matches_common_shapes() {
        assert!(looks_like_error(r#"{"error":"oops"}"#));
        assert!(looks_like_error(r#"{"success":false}"#));
        assert!(!looks_like_error("ok"));
    }
}
