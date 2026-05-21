# Cost-Per-Feature Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users tag sessions with free-form feature labels (e.g. `auth-refactor`, `mobile-release`), and view aggregated cost/tokens/duration per tag.

**Architecture:** New `session_tags` table (`session_id TEXT`, `tag TEXT`, `PRIMARY KEY(session_id, tag)`). `core::tags` exposes `list_tags`, `tags_for_session`, `set_tags_for_session`, `aggregate_by_tag`. CLI exposes `/api/session_tags` (GET list, POST set) and `/api/tags_summary` (aggregated). Frontend: a chip input on the session-detail row, and a new "Tags" page that shows a sortable table of tags with cost/tokens/sessions and links back to the session list filtered by tag.

**Tech Stack:** Rust, rusqlite, axum, React 18.

Note: the existing `/api/tags` route (per the codebase map) appears to be a different concept (likely scanner-derived). This plan introduces user-managed labels under `/api/session_tags` to avoid collision. If the existing `/api/tags` is unused, rename it instead.

---

## File Structure

- Create: `crates/token-dashboard-core/src/session_tags.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs` — `pub mod session_tags;`
- Modify: `crates/token-dashboard-core/src/db.rs` — migration adding `session_tags`
- Modify: `crates/token-dashboard-cli/src/lib.rs` — routes
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/sessions.jsx` — per-row tag editor
- Create: `frontend/src/routes/tags.jsx` — summary view
- Modify: navigation wherever route registration lives (search for `overview.jsx` in the route table)

---

### Task 1: Schema + core module skeleton

**Files:**
- Modify: `crates/token-dashboard-core/src/db.rs`
- Create: `crates/token-dashboard-core/src/session_tags.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Add the migration**

In `db.rs`, find the last `migrate_*` function and the `migrate()` entrypoint that calls all migrations in order. Add:

```rust
pub(crate) fn migrate_add_session_tags(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_tags (
            session_id TEXT NOT NULL,
            tag        TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, tag)
         );
         CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);"
    )?;
    Ok(())
}
```

Call `migrate_add_session_tags(conn)?;` inside the public `migrate()` after the other migrations.

- [ ] **Step 2: Skeleton + failing tests**

Create `session_tags.rs`:

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct TagSummary {
    pub tag: String,
    pub sessions: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
}

pub fn set_tags(conn: &Connection, session_id: &str, tags: &[String]) -> rusqlite::Result<()> { unimplemented!() }
pub fn tags_for_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<String>> { unimplemented!() }
pub fn aggregate_by_tag(conn: &Connection) -> rusqlite::Result<Vec<TagSummary>> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u1', 's1', 'p1', 'assistant', '2026-05-10T12:00:00Z', 'claude-opus-4-7', 100, 200, 0, 0, 0)", []).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u2', 's2', 'p1', 'assistant', '2026-05-11T12:00:00Z', 'claude-opus-4-7', 50, 75, 0, 0, 0)", []).unwrap();
        c
    }

    #[test]
    fn set_and_read_tags_replaces_set() {
        let c = setup();
        set_tags(&c, "s1", &["auth".into(), "refactor".into()]).unwrap();
        let mut t = tags_for_session(&c, "s1").unwrap();
        t.sort();
        assert_eq!(t, vec!["auth", "refactor"]);
        set_tags(&c, "s1", &["auth".into()]).unwrap();
        assert_eq!(tags_for_session(&c, "s1").unwrap(), vec!["auth"]);
    }

    #[test]
    fn aggregate_groups_costs_by_tag() {
        let c = setup();
        set_tags(&c, "s1", &["auth".into()]).unwrap();
        set_tags(&c, "s2", &["auth".into(), "mobile".into()]).unwrap();
        let agg = aggregate_by_tag(&c).unwrap();
        let auth = agg.iter().find(|t| t.tag == "auth").unwrap();
        assert_eq!(auth.sessions, 2);
        let mobile = agg.iter().find(|t| t.tag == "mobile").unwrap();
        assert_eq!(mobile.sessions, 1);
    }
}
```

In `lib.rs`: `pub mod session_tags;`

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core session_tags`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn set_tags(conn: &Connection, session_id: &str, tags: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM session_tags WHERE session_id = ?1", rusqlite::params![session_id])?;
    for t in tags {
        let trimmed = t.trim();
        if trimmed.is_empty() { continue; }
        tx.execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?1, ?2)",
            rusqlite::params![session_id, trimmed],
        )?;
    }
    tx.commit()
}

pub fn tags_for_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM session_tags WHERE session_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(rusqlite::params![session_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

pub fn aggregate_by_tag(conn: &Connection) -> rusqlite::Result<Vec<TagSummary>> {
    let pricing = crate::pricing::load_default();
    let mut stmt = conn.prepare(
        "SELECT st.tag, m.session_id, m.model, m.timestamp, \
                SUM(m.input_tokens), SUM(m.output_tokens), \
                SUM(m.cache_read_tokens), SUM(m.cache_create_5m_tokens), SUM(m.cache_create_1h_tokens) \
         FROM session_tags st JOIN messages m ON m.session_id = st.session_id \
         WHERE m.type = 'assistant' \
         GROUP BY st.tag, m.session_id, m.model"
    )?;
    let mut map: std::collections::BTreeMap<String, TagSummary> = Default::default();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?,
            r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64, r.get::<_, i64>(6)? as u64,
            r.get::<_, i64>(7)? as u64, r.get::<_, i64>(8)? as u64))
    })?;
    for row in rows {
        let (tag, session_id, model, ts, inp, out, cr, c5, c1) = row?;
        let entry = map.entry(tag.clone()).or_insert(TagSummary {
            tag: tag.clone(), sessions: 0, total_tokens: 0, cost_usd: 0.0,
            first_seen: None, last_seen: None,
        });
        entry.cost_usd += pricing.cost_for(model.as_deref(), inp, out, cr, c5, c1);
        entry.total_tokens += inp + out + cr + c5 + c1;
        entry.first_seen = Some(entry.first_seen.clone().map_or(ts.clone(), |f| f.min(ts.clone())));
        entry.last_seen = Some(entry.last_seen.clone().map_or(ts.clone(), |l| l.max(ts.clone())));
        // session counting: track unique session ids per tag
        let _ = session_id; // counted below
    }
    // Recount unique sessions separately to avoid double-count from per-model rows
    let mut session_counter = conn.prepare("SELECT tag, COUNT(DISTINCT session_id) FROM session_tags GROUP BY tag")?;
    for row in session_counter.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)))? {
        let (tag, count) = row?;
        if let Some(entry) = map.get_mut(&tag) { entry.sessions = count; }
    }
    Ok(map.into_values().collect())
}
```

- [ ] **Step 5: Confirm passing**

Run: `cargo test -p token-dashboard-core session_tags`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{db,session_tags,lib}.rs
git commit -m "feat(core): session_tags table + aggregation"
```

---

### Task 2: API routes

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Handlers**

```rust
#[derive(serde::Deserialize)]
struct SetTagsBody { session_id: String, tags: Vec<String> }

async fn get_session_tags(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> axum::response::Json<Vec<String>> {
    axum::response::Json(
        token_dashboard_core::session_tags::tags_for_session(&state.conn(), &session_id).unwrap_or_default()
    )
}

async fn post_session_tags(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<SetTagsBody>,
) -> axum::http::StatusCode {
    match token_dashboard_core::session_tags::set_tags(&state.conn(), &body.session_id, &body.tags) {
        Ok(_) => axum::http::StatusCode::NO_CONTENT,
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn get_tags_summary(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> axum::response::Json<Vec<token_dashboard_core::session_tags::TagSummary>> {
    axum::response::Json(
        token_dashboard_core::session_tags::aggregate_by_tag(&state.conn()).unwrap_or_default()
    )
}
```

Register:

```rust
.route("/api/session_tags/:session_id", axum::routing::get(get_session_tags))
.route("/api/session_tags", axum::routing::post(post_session_tags))
.route("/api/tags_summary", axum::routing::get(get_tags_summary))
```

- [ ] **Step 2: Smoke test**

```bash
curl -X POST http://127.0.0.1:8080/api/session_tags -H 'content-type: application/json' \
     -d '{"session_id":"existing-session-id","tags":["auth","refactor"]}'
curl http://127.0.0.1:8080/api/session_tags/existing-session-id
curl http://127.0.0.1:8080/api/tags_summary
```

Expected: 204; then `["auth","refactor"]`; then JSON list with sessions/cost.

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs
git commit -m "feat(cli): session_tags + tags_summary endpoints"
```

---

### Task 3: Tag editor on Sessions page

**Files:**
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/sessions.jsx`

- [ ] **Step 1: Client helpers**

```javascript
export async function getSessionTags(sessionId) {
  const r = await fetch(`/api/session_tags/${encodeURIComponent(sessionId)}`);
  return r.ok ? r.json() : [];
}
export async function setSessionTags(sessionId, tags) {
  await fetch(`/api/session_tags`, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ session_id: sessionId, tags }),
  });
}
```

- [ ] **Step 2: TagChips component**

Append to `sessions.jsx`:

```jsx
function TagChips({ sessionId, initial }) {
  const [tags, setTags] = useState(initial || []);
  const [draft, setDraft] = useState('');
  const commit = (next) => { setTags(next); setSessionTags(sessionId, next); };
  return (
    <div className="a-tag-chips">
      {tags.map(t => (
        <span key={t} className="a-chip">
          {t} <button onClick={() => commit(tags.filter(x => x !== t))}>×</button>
        </span>
      ))}
      <input
        value={draft}
        placeholder="+tag"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && draft.trim()) {
            commit([...new Set([...tags, draft.trim()])]);
            setDraft('');
          }
        }}
      />
    </div>
  );
}
```

Render `<TagChips sessionId={row.session_id} initial={row.tags || []} />` in the row template.

- [ ] **Step 3: Server-side join**

Modify `queries::list_sessions` (or whatever feeds `/api/sessions`) to LEFT JOIN session_tags and return a comma-delimited `tags` field. Alternatively, fetch tags in parallel from the client per row (only acceptable for small lists; prefer the server join).

- [ ] **Step 4: Manual check**

Add a tag in the UI, refresh, confirm persistence.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api-client.js frontend/src/routes/sessions.jsx crates/token-dashboard-core/src/queries.rs
git commit -m "feat(ui): per-session tag editor"
```

---

### Task 4: Tags summary view

**Files:**
- Create: `frontend/src/routes/tags.jsx`
- Modify: wherever the route table lives (search for `<Route path="/sessions"`)

- [ ] **Step 1: Create the view**

```jsx
import React, { useEffect, useState } from 'react';

export default function TagsView() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    fetch('/api/tags_summary').then(r => r.json()).then(setRows);
  }, []);
  return (
    <div className="a-card">
      <div className="a-card-head">Cost per tag</div>
      <table className="a-table">
        <thead><tr><th>Tag</th><th>Sessions</th><th>Tokens</th><th>Cost ($)</th><th>First</th><th>Last</th></tr></thead>
        <tbody>
          {rows.sort((a,b)=>b.cost_usd-a.cost_usd).map(r => (
            <tr key={r.tag}>
              <td><a href={`#/sessions?tag=${encodeURIComponent(r.tag)}`}>{r.tag}</a></td>
              <td>{r.sessions}</td>
              <td>{r.total_tokens.toLocaleString()}</td>
              <td>${r.cost_usd.toFixed(2)}</td>
              <td>{r.first_seen?.slice(0,10) ?? '—'}</td>
              <td>{r.last_seen?.slice(0,10) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

Find the existing route table (likely in `frontend/src/App.jsx` or `routes/index.jsx`) and add a `Route path="/tags"`. Add a nav entry next to "Sessions".

- [ ] **Step 3: Filter sessions by tag**

In `sessions.jsx`, read `?tag=` from `window.location.hash`. If set, filter rows where `row.tags?.includes(tag)`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/tags.jsx frontend/src/App.jsx frontend/src/routes/sessions.jsx
git commit -m "feat(ui): tags summary + sessions filter"
```

---

## Self-Review Notes

- Confirm migration runs idempotently — `migrate()` is called every process start.
- If `/api/tags` already returns user labels (not just scanner-derived), reuse it instead of adding `/api/session_tags`. Inspect first.
- Tag input does not yet support autocomplete from existing tags; that's an iteration-2 feature.
