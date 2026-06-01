use praetorium_core::sessions::{
    list_all_sessions as core_list_all_sessions, list_sessions as core_list_sessions,
    read_session_sync, SessionMeta, Turn,
};
use std::path::Path;

/// List top-level session logs in a project directory.
#[tauri::command]
pub async fn list_sessions(project_dir: String) -> Result<Vec<SessionMeta>, String> {
    core_list_sessions(Path::new(&project_dir))
}

/// Parse a session jsonl file into displayable turns.
#[tauri::command]
pub async fn read_session(path: String) -> Result<Vec<Turn>, String> {
    read_session_sync(Path::new(&path))
}

/// Scan ~/.claude/projects/*/ and return every top-level session.
#[tauri::command]
pub async fn list_all_sessions() -> Result<Vec<SessionMeta>, String> {
    core_list_all_sessions()
}
