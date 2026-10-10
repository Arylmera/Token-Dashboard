use praetorium_core::session_parse::{parse_transcript_line, SessionEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::Manager;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub project: String,
    pub title: String,
    pub last_activity_ms: u64,
    pub state: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    content = "data"
)]
pub enum WatchEvent {
    Session {
        session_id: String,
        project: String,
        repo: Option<String>,
        agent_ref: String,
        event: SessionEvent,
    },
    State {
        session_id: String,
        state: String,
    },
}

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}
fn projects_root() -> PathBuf {
    home().join(".claude").join("projects")
}

fn is_main_session(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("jsonl")
        && !path.components().any(|c| c.as_os_str() == "subagents")
}
fn agent_ref_for(path: &Path) -> String {
    if is_main_session(path) {
        return "master".into();
    }
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_string()
}
fn session_id_for(path: &Path) -> Option<String> {
    if is_main_session(path) {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    } else {
        path.parent()?
            .parent()?
            .file_name()?
            .to_str()
            .map(|s| s.to_string())
    }
}
fn project_for(path: &Path) -> String {
    // main: .../projects/<project>/<id>.jsonl  ; sub: .../projects/<project>/<id>/subagents/agent.jsonl
    let comps: Vec<_> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    if let Some(i) = comps.iter().position(|c| *c == "projects") {
        comps.get(i + 1).map(|s| s.to_string()).unwrap_or_default()
    } else {
        String::new()
    }
}
fn basename(p: &str) -> String {
    p.rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}
/// Parent-repo name for a git-worktree cwd (`<repo>/.claude/worktrees/<name>`):
/// the path segment just before `.claude`. None when the cwd isn't in a worktree.
fn repo_for_cwd(cwd: &str) -> Option<String> {
    let comps: Vec<&str> = cwd.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    comps
        .iter()
        .position(|c| *c == ".claude")
        .filter(|&i| i >= 1 && comps.get(i + 1) == Some(&"worktrees"))
        .map(|i| comps[i - 1].to_string())
}
fn line_cwd(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    v.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string())
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
const LIVE_WINDOW_MS: u64 = 60_000;

/// First `f` hit scanning `path` line by line. Stops reading at the hit, so
/// header-ish fields (cwd, first prompt) cost a few lines, not the whole
/// multi-megabyte transcript.
fn first_line_match<T>(path: &Path, mut f: impl FnMut(&str) -> Option<T>) -> Option<T> {
    let file = std::fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .find_map(|l| f(&l))
}

/// A live session's transcript routinely reaches several megabytes. Replaying it
/// from byte 0 pushes every historical line through the JS reducers at startup,
/// so only the tail is reconstructed.
const REPLAY_MAX_BYTES: usize = 262_144;
// `replay_is_bounded_to_the_tail_for_large_live_files` sizes its file FROM the
// constant, so it stays green however far the window is raised. This is what
// actually bounds the replay, and it fails the build rather than a test.
const _: () = assert!(REPLAY_MAX_BYTES <= 1 << 20);

/// Decide how to seed a session file's read offset at startup.
/// Live files (modified within the live window) replay their tail so an
/// already-running session is reconstructed; everything else jumps to EOF.
#[derive(Debug)]
enum Seed {
    /// Replay from this byte offset. May land mid-line and mid-character;
    /// the partial first line fails to parse as JSON, so
    /// `parse_transcript_line` drops it.
    Replay(usize),
    SkipTo(usize),
}
fn seed_for(len: usize, age_ms: u64) -> Seed {
    if age_ms <= LIVE_WINDOW_MS {
        Seed::Replay(len.saturating_sub(REPLAY_MAX_BYTES))
    } else {
        Seed::SkipTo(len)
    }
}

#[tauri::command]
pub fn list_live_sessions() -> Result<Vec<SessionMeta>, String> {
    let root = projects_root();
    let mut out = vec![];
    let projects = std::fs::read_dir(&root).map_err(|e| format!("read projects: {e}"))?;
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let project = proj.file_name().to_string_lossy().to_string();
        let files = match std::fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let path = f.path();
            if !is_main_session(&path) {
                continue;
            }
            let meta = match f.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let age = now_ms().saturating_sub(mtime);
            if age > 10 * LIVE_WINDOW_MS {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let cwd_full = first_line_match(&path, line_cwd);
            let cwd_basename = cwd_full.as_deref().map(basename);
            let friendly_project = cwd_basename.unwrap_or_else(|| project.clone());
            let title = first_line_match(&path, |l| {
                parse_transcript_line(l).into_iter().find_map(|e| {
                    if let SessionEvent::Turn { role, text } = e {
                        if role == "user" {
                            Some(text)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
            })
            .map(|t| t.chars().take(80).collect::<String>())
            .unwrap_or_else(|| id.clone());
            let state = if age <= LIVE_WINDOW_MS {
                "live"
            } else {
                "idle"
            }
            .to_string();
            out.push(SessionMeta {
                id,
                project: friendly_project,
                title,
                last_activity_ms: mtime,
                state,
                cwd: cwd_full,
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.last_activity_ms));
    Ok(out)
}

#[tauri::command]
pub fn app_cwd() -> Option<String> {
    std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Default)]
pub struct WatchState(pub Mutex<HashMap<PathBuf, usize>>);

#[derive(Default)]
pub struct WatcherHandle(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Complete lines appended to `path` after byte `offset`, plus the offset to
/// resume from. Reads only the new bytes: transcripts reach tens of megabytes
/// and every appended line fires a watch event, so re-reading the whole file
/// each time kept a core busy whenever Claude was working. A trailing partial
/// line stays for the next call; an `offset` past EOF (file truncated or
/// replaced) restarts at 0. `offset` may land mid-line (bounded replay seed):
/// that fragment fails the caller's JSON parse and is dropped.
fn read_appended(path: &Path, offset: usize) -> Option<(Vec<String>, usize)> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len() as usize;
    let start = if offset > len { 0 } else { offset };
    let mut fresh = Vec::new();
    file.seek(SeekFrom::Start(start as u64)).ok()?;
    file.read_to_end(&mut fresh).ok()?;
    let Some(idx) = fresh.iter().rposition(|&b| b == b'\n') else {
        return Some((vec![], start));
    };
    let lines = String::from_utf8_lossy(&fresh[..=idx])
        .lines()
        .map(str::to_string)
        .collect();
    Some((lines, start + idx + 1))
}

fn pump(path: &Path, offsets: &Mutex<HashMap<PathBuf, usize>>, ch: &Arc<Channel<WatchEvent>>) {
    let Some(session_id) = session_id_for(path) else {
        return;
    };
    let agent_ref = agent_ref_for(path);
    let mut map = offsets.lock().unwrap();
    let off = *map.get(path).unwrap_or(&0);
    let Some((lines, new_off)) = read_appended(path, off) else {
        return;
    };
    map.insert(path.to_path_buf(), new_off);
    drop(map);
    if lines.is_empty() {
        return;
    }
    let cwd = first_line_match(path, line_cwd);
    let project = cwd
        .as_deref()
        .map(basename)
        .unwrap_or_else(|| project_for(path));
    let repo = cwd.as_deref().and_then(repo_for_cwd);
    for line in lines {
        for event in parse_transcript_line(&line) {
            let _ = ch.send(WatchEvent::Session {
                session_id: session_id.clone(),
                project: project.clone(),
                repo: repo.clone(),
                agent_ref: agent_ref.clone(),
                event,
            });
        }
    }
}

#[tauri::command]
pub fn watch_sessions(app: tauri::AppHandle, on_event: Channel<WatchEvent>) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};
    let root = projects_root();
    let ch = Arc::new(on_event);
    // Seed read offsets: live files (active within LIVE_WINDOW_MS) replay their
    // last REPLAY_MAX_BYTES so already-running sessions are reconstructed;
    // everything else jumps to EOF and streams only NEW activity.
    let offsets: Arc<Mutex<HashMap<PathBuf, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut to_backfill: Vec<PathBuf> = Vec::new();
    let mut seed = |p: PathBuf, meta: &std::fs::Metadata| {
        let len = meta.len() as usize;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let age = now_ms().saturating_sub(mtime);
        match seed_for(len, age) {
            Seed::Replay(start) => {
                offsets.lock().unwrap().insert(p.clone(), start);
                to_backfill.push(p);
            }
            Seed::SkipTo(off) => {
                offsets.lock().unwrap().insert(p, off);
            }
        }
    };
    if let Ok(rd) = std::fs::read_dir(&root) {
        for proj in rd.flatten() {
            if let Ok(files) = std::fs::read_dir(proj.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        if let Ok(m) = f.metadata() {
                            seed(p.clone(), &m);
                        }
                    }
                    // also seed subagent files one level deeper
                    if p.is_dir() {
                        if let Ok(sub) = std::fs::read_dir(p.join("subagents")) {
                            for sf in sub.flatten() {
                                let sp = sf.path();
                                if sp.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                                    if let Ok(m) = sf.metadata() {
                                        seed(sp, &m);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Replay backlog of live sessions before the watcher starts; pump advances
    // each offset to EOF so the watcher never re-emits these lines.
    for p in &to_backfill {
        pump(p, &offsets, &ch);
    }
    let ch2 = ch.clone();
    let off2 = offsets.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                for p in ev.paths {
                    if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        pump(&p, &off2, &ch2);
                    }
                }
            }
        }
    })
    .map_err(|e| format!("watcher: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch: {e}"))?;
    // Single owning watcher: the handle is managed once at app startup, so we
    // store (and replace) the watcher inside it rather than `app.manage`-ing a
    // fresh one — calling manage twice panics, which the pop-out window's
    // re-dock cycle would otherwise trigger. Replacing drops the prior watcher
    // (stopping it) and re-binds streaming to the current window's Channel, so
    // whichever window owns the Live view is the live event sink.
    let handle = app.state::<WatcherHandle>();
    *handle.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_appended_returns_only_new_complete_lines() {
        let p = std::env::temp_dir().join(format!("td-read-appended-{}.jsonl", std::process::id()));
        std::fs::write(&p, "a\nb\nccc").unwrap();
        let (l, off) = read_appended(&p, 0).unwrap();
        assert_eq!((l, off), (vec!["a".to_string(), "b".to_string()], 4));
        // Partial line held back until its newline lands.
        assert_eq!(read_appended(&p, off).unwrap(), (vec![], 4));
        std::fs::write(&p, "a\nb\nccc\nd\n").unwrap();
        let (l, off) = read_appended(&p, off).unwrap();
        assert_eq!((l, off), (vec!["ccc".to_string(), "d".to_string()], 10));
        // Truncated file: offset past EOF restarts from 0.
        std::fs::write(&p, "x\n").unwrap();
        assert_eq!(read_appended(&p, off).unwrap(), (vec!["x".to_string()], 2));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn live_files_replay_others_skip_to_eof() {
        assert!(matches!(seed_for(100, 0), Seed::Replay(_)));
        assert!(matches!(seed_for(100, LIVE_WINDOW_MS), Seed::Replay(_)));
        assert!(matches!(
            seed_for(100, LIVE_WINDOW_MS + 1),
            Seed::SkipTo(100)
        ));
    }

    #[test]
    fn replay_starts_at_zero_for_small_live_files() {
        assert!(matches!(seed_for(1_000, 0), Seed::Replay(0)));
    }

    #[test]
    fn replay_is_bounded_to_the_tail_for_large_live_files() {
        let len = REPLAY_MAX_BYTES + 500_000;
        match seed_for(len, 0) {
            Seed::Replay(off) => {
                assert_eq!(off, len - REPLAY_MAX_BYTES);
                assert!(len - off <= REPLAY_MAX_BYTES);
            }
            other => panic!("expected bounded Replay, got {other:?}"),
        }
    }

    #[test]
    fn stale_files_still_skip_to_eof() {
        assert!(matches!(
            seed_for(9_000_000, LIVE_WINDOW_MS + 1),
            Seed::SkipTo(9_000_000)
        ));
    }

    #[test]
    fn repo_for_cwd_detects_worktree_parent() {
        assert_eq!(
            repo_for_cwd("C:\\Users\\u\\git\\praetorium\\.claude\\worktrees\\gallant-tesla-f7dbcd"),
            Some("praetorium".into())
        );
        assert_eq!(
            repo_for_cwd("/home/u/git/praetorium/.claude/worktrees/foo"),
            Some("praetorium".into())
        );
        assert_eq!(repo_for_cwd("/home/u/git/praetorium"), None); // not a worktree
        assert_eq!(repo_for_cwd("/home/u/.claude/projects/x"), None); // .claude but not worktrees
    }
}
