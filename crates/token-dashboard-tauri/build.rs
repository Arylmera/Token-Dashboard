fn main() {
    // Declare the app's own #[tauri::command] functions so tauri-build generates
    // `allow-<command>` / `deny-<command>` ACL permissions for them. Without this,
    // app commands have no permission identifiers and cannot be granted to the
    // remote-served webview (http://127.0.0.1:*), so every Live IPC call fails
    // with "Command <x> not allowed by ACL". The list must mirror the
    // `generate_handler!` invoke handler in main.rs.
    const COMMANDS: &[&str] = &[
        "open_external",
        "open_widget",
        "open_setup_help",
        "close_widget",
        "is_widget_open",
        "show_main",
        "show_main_route",
        "set_glass",
        "open_live_window",
        "close_live_window",
        "is_live_window_open",
        "run_claude",
        "stop_claude",
        "read_vault_file",
        "vault_index",
        "vault_links",
        "list_sessions",
        "read_session",
        "list_all_sessions",
        "list_live_sessions",
        "watch_sessions",
        "app_cwd",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
