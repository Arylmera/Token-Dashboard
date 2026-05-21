// Auto-split from lib.rs — pure helpers, no state/handler dependencies.
use serde::Deserialize;

pub(crate) fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub(crate) fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

// Distinguish "field absent" from "field: null". Plain Option<T> collapses
// both to None, so we need an outer Option to mark presence and an inner
// Option to carry the value-or-null.
pub(crate) fn deserialize_double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

pub(crate) fn current_iso_z() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

/// Max upload size for /api/sources/add and /api/import.db. Mirrors the
/// python `MAX_IMPORT_BYTES` (200 MiB) — sized to fit a year of typical
/// usage in one snapshot without allowing pathological uploads.
pub(crate) const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

pub(crate) fn pragma_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("pragma: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub(crate) fn pragma_columns_attached(
    conn: &rusqlite::Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA {schema}.table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("pragma: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Append one CSV row using RFC 4180 minimal quoting. Mirrors python's
/// `csv.QUOTE_MINIMAL` — fields containing comma, quote, or newline get
/// quoted; embedded quotes are doubled.
pub(crate) fn push_csv_row(buf: &mut String, fields: &[&str]) {
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        let needs_quote = f.contains(',') || f.contains('"') || f.contains('\n');
        if needs_quote {
            buf.push('"');
            for c in f.chars() {
                if c == '"' {
                    buf.push_str("\"\"");
                } else {
                    buf.push(c);
                }
            }
            buf.push('"');
        } else {
            buf.push_str(f);
        }
    }
    buf.push('\n');
}

pub(crate) fn tempfile_path() -> rusqlite::Result<std::path::PathBuf> {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("td-export-{nanos}.db"));
    Ok(p)
}

pub(crate) fn unix_compact_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    let s = secs % 86_400;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{sec:02}")
}

pub(crate) fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Mirrors python `clamp_limit`: bound 1..=max_default*10 and fall back
/// on parse errors. Caller may pass any user-supplied value.
pub(crate) fn clamp_limit(raw: i64, default: i64) -> i64 {
    let upper = default * 10;
    raw.clamp(1, upper)
}
