use praetorium_core::session_parse::{parse_transcript_line, tail_new, SessionEvent};
use serde::Serialize;
use std::collections::HashMap;
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

/// Decide how to seed a session file's read offset at startup.
/// Live files (modified within the live window) replay from the start so an
/// already-running session is reconstructed; everything else jumps to EOF.
enum Seed {
    Replay,
    SkipTo(usize),
}
fn seed_for(len: usize, age_ms: u64) -> Seed {
    if age_ms <= LIVE_WINDOW_MS {
        Seed::Replay
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
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let cwd_full = content.lines().find_map(line_cwd);
            let cwd_basename = cwd_full.as_deref().map(basename);
            let friendly_project = cwd_basename.unwrap_or_else(|| project.clone());
            let title = content
                .lines()
                .find_map(|l| {
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

pub struct WatcherHandle(pub Mutex<Option<notify::RecommendedWatcher>>);

fn pump(path: &Path, offsets: &Mutex<HashMap<PathBuf, usize>>, ch: &Arc<Channel<WatchEvent>>) {
    let Some(session_id) = session_id_for(path) else {
        return;
    };
    let agent_ref = agent_ref_for(path);
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let cwd = content.lines().find_map(line_cwd);
    let project = cwd
        .as_deref()
        .map(basename)
        .unwrap_or_else(|| project_for(path));
    let repo = cwd.as_deref().and_then(repo_for_cwd);
    let mut map = offsets.lock().unwrap();
    let off = *map.get(path).unwrap_or(&0);
    let start = if off > content.len() { 0 } else { off };
    let (lines, new_off) = tail_new(&content, start);
    map.insert(path.to_path_buf(), new_off);
    drop(map);
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
    // Seed read offsets: live files (active within LIVE_WINDOW_MS) replay from
    // the start so already-running sessions are reconstructed; everything else
    // jumps to EOF and streams only NEW activity.
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
            Seed::Replay => {
                offsets.lock().unwrap().insert(p.clone(), 0);
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
    app.manage(WatcherHandle(Mutex::new(Some(watcher))));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_files_replay_others_skip_to_eof() {
        assert!(matches!(seed_for(100, 0), Seed::Replay));
        assert!(matches!(seed_for(100, LIVE_WINDOW_MS), Seed::Replay));
        assert!(matches!(
            seed_for(100, LIVE_WINDOW_MS + 1),
            Seed::SkipTo(100)
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
