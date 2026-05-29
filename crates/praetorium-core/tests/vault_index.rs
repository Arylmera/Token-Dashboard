use praetorium_core::vault::vault_index_sync;
use std::fs;

#[test]
fn indexes_md_and_skips_archive() {
    let dir = std::env::temp_dir().join(format!("praetorium_vi_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("Sub")).unwrap();
    fs::create_dir_all(dir.join("Archive")).unwrap();
    fs::write(dir.join("Root.md"), "x").unwrap();
    fs::write(dir.join("Sub/Child.md"), "x").unwrap();
    fs::write(dir.join("Sub/notes.txt"), "x").unwrap();
    fs::write(dir.join("Archive/Sealed.md"), "x").unwrap();

    let files = vault_index_sync(&dir).unwrap();
    let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
    assert!(names.contains(&"Root"));
    assert!(names.contains(&"Child"));
    assert!(!names.contains(&"notes"), "non-md excluded");
    assert!(!names.contains(&"Sealed"), "Archive skipped");
    let _ = fs::remove_dir_all(&dir);
}
