use praetorium_core::vault::{
    read_vault_file_sync, vault_index_sync, vault_links_sync, NoteLinks, VaultFile,
};
use std::path::Path;

/// List all .md files under the vault (skips Archive/.git/node_modules).
#[tauri::command]
pub async fn vault_index(vault_path: String) -> Result<Vec<VaultFile>, String> {
    vault_index_sync(Path::new(&vault_path))
}

/// Read a UTF-8 .md file from disk.
#[tauri::command]
pub async fn read_vault_file(path: String) -> Result<String, String> {
    read_vault_file_sync(Path::new(&path))
}

/// Walk the vault's `.md` files and return each note's resolved `[[wikilink]]` adjacency.
#[tauri::command]
pub async fn vault_links(vault_path: String) -> Result<Vec<NoteLinks>, String> {
    vault_links_sync(Path::new(&vault_path))
}
