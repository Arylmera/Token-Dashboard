//! Unit tests for the `power_level` preference (default + clamping).

use tempfile::TempDir;
use token_dashboard_core::init_db;
use token_dashboard_core::preferences::{get_power_level, set_power_level};

fn fresh_db() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    init_db(&db).unwrap();
    (tmp, db)
}

#[test]
fn defaults_to_basic() {
    let (_tmp, db) = fresh_db();
    assert_eq!(get_power_level(&db).unwrap(), 1);
}

#[test]
fn round_trips_valid_level() {
    let (_tmp, db) = fresh_db();
    assert_eq!(set_power_level(&db, 3).unwrap(), 3);
    assert_eq!(get_power_level(&db).unwrap(), 3);
}

#[test]
fn clamps_out_of_range() {
    let (_tmp, db) = fresh_db();
    assert_eq!(set_power_level(&db, 0).unwrap(), 1);
    assert_eq!(set_power_level(&db, 9).unwrap(), 4);
    assert_eq!(get_power_level(&db).unwrap(), 4);
}
