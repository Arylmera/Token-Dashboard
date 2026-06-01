// Live session command post — ported from Praetorium. Drives the `claude`
// CLI as a subprocess (`process`) and watches `~/.claude/projects/` on disk
// (`session_watch`), streaming parsed events to the frontend over Tauri IPC
// channels. `sessions`/`vault` are thin #[tauri::command] wrappers over
// `praetorium-core`. This is the only part of the app with a process model;
// the analytics surface stays passive and read-only.
//
// `unreachable_pub`: these modules are a private subtree of a binary crate,
// so their `pub` items (required by the `#[tauri::command]` macro and the IPC
// type contract) are never externally reachable — that's expected here.
// `dead_code`: a few items (the `WatcherHandle` field kept alive via
// `manage`, the `WatchState`/`WatchEvent::State` frontend-contract types) are
// intentionally retained.

#[allow(unreachable_pub, dead_code)]
pub mod process;
#[allow(unreachable_pub, dead_code)]
pub mod session_watch;
#[allow(unreachable_pub, dead_code)]
pub mod sessions;
#[allow(unreachable_pub, dead_code)]
pub mod vault;
