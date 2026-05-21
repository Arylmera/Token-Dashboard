# CSV / Parquet Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users export the underlying analytics tables (`messages`, `tool_calls`, `daily aggregates`) as CSV (always) and Parquet (optional, gated behind a feature flag because of the dep weight). Triggered from Settings → Export.

**Architecture:** New `core::export` exposes `export_csv(conn, table, writer)` and (under feature `parquet`) `export_parquet(conn, table, writer)`. CLI exposes `GET /api/export?table=…&format=csv|parquet` that streams the file. The Tauri shell wires a "Save to disk" command that uses the OS file dialog. Default builds skip Parquet to keep binary size sane.

**Tech Stack:** Rust (`csv` crate, optional `arrow` + `parquet` crates), axum streaming, Tauri dialog plugin.

---

## File Structure

- Create: `crates/token-dashboard-core/src/export.rs`
- Modify: `crates/token-dashboard-core/src/Cargo.toml` — `csv = "1"`, optional `arrow`/`parquet` under feature `parquet`
- Modify: `crates/token-dashboard-core/src/lib.rs` — `pub mod export;`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `crates/token-dashboard-tauri/src/main.rs` — Tauri command + dialog
- Modify: `frontend/src/routes/settings.jsx` (or a new `settings/export-card.jsx`)

---

### Task 1: CSV core

**Files:**
- Modify: `crates/token-dashboard-core/Cargo.toml`
- Create: `crates/token-dashboard-core/src/export.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Add dep**

In `crates/token-dashboard-core/Cargo.toml`:

```toml
[dependencies]
csv = "1"

[features]
default = []
parquet = ["dep:arrow", "dep:parquet"]

[dependencies.arrow]
version = "53"
optional = true

[dependencies.parquet]
version = "53"
optional = true
```

- [ ] **Step 2: Module + failing test**

```rust
use rusqlite::Connection;

pub fn export_csv<W: std::io::Write>(conn: &Connection, table: &str, writer: W) -> anyhow::Result<usize> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u1','s','p','assistant','2026-05-20T10:00:00Z','claude-opus-4-7',1,2,0,0,0)", []).unwrap();
    }

    #[test]
    fn exports_messages_as_csv() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let mut buf = Vec::new();
        let n = export_csv(&c, "messages", &mut buf).unwrap();
        assert_eq!(n, 1);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("uuid"));
        assert!(s.contains("u1"));
    }

    #[test]
    fn rejects_unknown_table() {
        let c = Connection::open_in_memory().unwrap();
        let mut buf = Vec::new();
        assert!(export_csv(&c, "../../etc/passwd; DROP TABLE messages;", &mut buf).is_err());
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core export`
Expected: FAIL.

- [ ] **Step 4: Implement (with allowlist)**

```rust
const ALLOWED_TABLES: &[&str] = &["messages", "tool_calls", "sessions", "files", "session_tags"];

pub fn export_csv<W: std::io::Write>(conn: &Connection, table: &str, writer: W) -> anyhow::Result<usize> {
    if !ALLOWED_TABLES.contains(&table) {
        anyhow::bail!("table not allowed: {table}");
    }
    // table name is now caller-controlled and matched to allowlist, safe for format!
    let sql = format!("SELECT * FROM {table}");
    let mut stmt = conn.prepare(&sql)?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = col_names.len();

    let mut wtr = csv::Writer::from_writer(writer);
    wtr.write_record(&col_names)?;
    let mut rows = stmt.query([])?;
    let mut written = 0usize;
    while let Some(row) = rows.next()? {
        let mut record: Vec<String> = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let val: rusqlite::types::Value = row.get(i)?;
            record.push(match val {
                rusqlite::types::Value::Null => String::new(),
                rusqlite::types::Value::Integer(n) => n.to_string(),
                rusqlite::types::Value::Real(f) => f.to_string(),
                rusqlite::types::Value::Text(s) => s,
                rusqlite::types::Value::Blob(b) => format!("<blob {} bytes>", b.len()),
            });
        }
        wtr.write_record(&record)?;
        written += 1;
    }
    wtr.flush()?;
    Ok(written)
}
```

- [ ] **Step 5: Tests pass**

`cargo test -p token-dashboard-core export` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/{Cargo.toml,src/lib.rs,src/export.rs}
git commit -m "feat(core): csv export with table allowlist"
```

---

### Task 2: Parquet (feature-gated)

**Files:**
- Modify: `crates/token-dashboard-core/src/export.rs`

- [ ] **Step 1: Add the function under feature**

```rust
#[cfg(feature = "parquet")]
pub fn export_parquet<W: std::io::Write + Send>(conn: &Connection, table: &str, writer: W) -> anyhow::Result<usize> {
    use arrow::array::{ArrayRef, Int64Array, StringArray, Float64Array};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc;

    if !ALLOWED_TABLES.contains(&table) { anyhow::bail!("table not allowed: {table}"); }
    let sql = format!("SELECT * FROM {table}");
    let mut stmt = conn.prepare(&sql)?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    // Pull everything into memory as strings (simplest cross-table approach); cast on dump.
    let mut text_cols: Vec<Vec<Option<String>>> = vec![Vec::new(); col_names.len()];
    let mut rows = stmt.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        for i in 0..col_names.len() {
            let v: rusqlite::types::Value = row.get(i)?;
            text_cols[i].push(match v {
                rusqlite::types::Value::Null => None,
                other => Some(format!("{other:?}").trim_matches('"').to_string()),
            });
        }
        count += 1;
    }
    let fields: Vec<Field> = col_names.iter().map(|n| Field::new(n, DataType::Utf8, true)).collect();
    let schema = Arc::new(Schema::new(fields));
    let arrays: Vec<ArrayRef> = text_cols.into_iter()
        .map(|c| Arc::new(StringArray::from(c)) as ArrayRef).collect();
    let batch = RecordBatch::try_new(schema.clone(), arrays)?;
    let mut w = ArrowWriter::try_new(writer, schema, None)?;
    w.write(&batch)?;
    w.close()?;
    Ok(count)
}
```

- [ ] **Step 2: Test under feature**

```rust
#[cfg(all(test, feature = "parquet"))]
mod parquet_tests {
    use super::*;
    #[test]
    fn exports_messages_as_parquet() {
        let c = Connection::open_in_memory().unwrap();
        super::tests::seed(&c);
        let mut buf = Vec::new();
        let n = export_parquet(&c, "messages", &mut buf).unwrap();
        assert_eq!(n, 1);
        assert!(!buf.is_empty());
    }
}
```

Run: `cargo test -p token-dashboard-core --features parquet export`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-core/{src/export.rs,Cargo.toml}
git commit -m "feat(core): optional parquet export (feature=parquet)"
```

---

### Task 3: API + Settings UI

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/routes/settings.jsx`

- [ ] **Step 1: Endpoint**

```rust
#[derive(serde::Deserialize)]
struct ExportQuery { table: String, format: Option<String> }

async fn get_export(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ExportQuery>,
) -> axum::response::Response {
    let format = q.format.as_deref().unwrap_or("csv");
    let mut buf: Vec<u8> = Vec::new();
    match format {
        "csv" => {
            if let Err(e) = token_dashboard_core::export::export_csv(&state.conn(), &q.table, &mut buf) {
                return (axum::http::StatusCode::BAD_REQUEST, e.to_string()).into_response();
            }
            ([(axum::http::header::CONTENT_TYPE, "text/csv"),
              (axum::http::header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{}.csv\"", q.table))],
             buf).into_response()
        }
        _ => (axum::http::StatusCode::BAD_REQUEST, "format not supported").into_response(),
    }
}
```

Register `.route("/api/export", axum::routing::get(get_export))`.

- [ ] **Step 2: Settings UI**

In `settings.jsx`, add:

```jsx
function ExportCard() {
  const tables = ['messages', 'tool_calls', 'sessions', 'session_tags'];
  return (
    <div className="a-card">
      <div className="a-card-head">Export</div>
      {tables.map(t => (
        <a key={t} className="a-btn" href={`/api/export?table=${t}&format=csv`} download>
          {t}.csv
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/routes/settings.jsx
git commit -m "feat: export endpoint + Settings download buttons"
```

---

## Self-Review Notes

- `format!("SELECT * FROM {table}")` is safe **only** because of the allowlist; never relax it.
- Parquet feature is off by default to keep the default binary small. Document the flag in README if shipping.
- Large tables stream as a single response — fine for hundreds of thousands of rows; consider chunked SSE for millions later.
