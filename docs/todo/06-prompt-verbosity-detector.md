# Prompt Verbosity Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find prompts where the user wrote a lot but got a tiny response — likely wasted verbosity. Surface them in a "wasted prompts" list with the prompt preview and the input/output ratio.

**Architecture:** `core::verbosity` queries user-message-to-assistant-response pairs (joined via `parent_uuid` or by ordering within a session), computes input_chars / output_tokens, ranks pairs above a configurable ratio threshold. Endpoint `/api/verbosity?min_chars=200&top=50`. UI: a new tab on the prompts page, or a card on Overview.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/verbosity.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/prompts.jsx` — add "Verbosity" view/tab

---

### Task 1: Core pairing query

**Files:**
- Create: `crates/token-dashboard-core/src/verbosity.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Add module**

```rust
pub mod verbosity;
```

- [ ] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct WastedPrompt {
    pub session_id: String,
    pub timestamp: String,
    pub prompt_chars: u64,
    pub output_tokens: u64,
    pub ratio: f64,            // prompt_chars / max(output_tokens, 1)
    pub preview: String,       // first 240 chars
    pub model: Option<String>,
}

pub fn worst(conn: &Connection, min_chars: u32, top: u32) -> rusqlite::Result<Vec<WastedPrompt>> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // user prompt 'u' with 1000 chars
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, prompt_text, prompt_chars, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u1','s1','p1','user','2026-05-20T10:00:00Z','hello '||randomblob(500), 1000, NULL, 0,0,0,0,0)", []).unwrap();
        // assistant follow-up, 5 output tokens
        c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a1','u1','s1','p1','assistant','2026-05-20T10:00:01Z','claude-opus-4-7',200,5,0,0,0)", []).unwrap();
    }

    #[test]
    fn returns_prompts_with_high_ratio() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let rows = worst(&c, 100, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ratio >= 200.0);
        assert_eq!(rows[0].output_tokens, 5);
    }
}
```

- [ ] **Step 3: Confirm fail**

Run: `cargo test -p token-dashboard-core verbosity`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn worst(conn: &Connection, min_chars: u32, top: u32) -> rusqlite::Result<Vec<WastedPrompt>> {
    let mut stmt = conn.prepare(
        "SELECT u.session_id, u.timestamp, u.prompt_chars, u.prompt_text, \
                a.model, a.output_tokens \
         FROM messages u \
         JOIN messages a ON a.parent_uuid = u.uuid AND a.type = 'assistant' \
         WHERE u.type = 'user' AND u.prompt_chars >= ?1 \
         ORDER BY (CAST(u.prompt_chars AS REAL) / MAX(a.output_tokens, 1)) DESC \
         LIMIT ?2"
    )?;
    let rows = stmt.query_map(rusqlite::params![min_chars as i64, top as i64], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u64,
            r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)? as u64))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (session_id, timestamp, prompt_chars, prompt_text, model, output_tokens) = row?;
        let ratio = prompt_chars as f64 / output_tokens.max(1) as f64;
        let preview = prompt_text.as_deref().unwrap_or("").chars().take(240).collect();
        out.push(WastedPrompt { session_id, timestamp, prompt_chars, output_tokens, ratio, preview, model });
    }
    Ok(out)
}
```

- [ ] **Step 5: Run**

`cargo test -p token-dashboard-core verbosity` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,verbosity}.rs
git commit -m "feat(core): prompt verbosity ranking"
```

---

### Task 2: API + UI

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/prompts.jsx`

- [ ] **Step 1: Handler**

```rust
#[derive(serde::Deserialize, Default)]
struct VerbosityQuery { min_chars: Option<u32>, top: Option<u32> }

async fn get_verbosity(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<VerbosityQuery>,
) -> axum::response::Json<Vec<token_dashboard_core::verbosity::WastedPrompt>> {
    let min_chars = q.min_chars.unwrap_or(200).clamp(1, 1_000_000);
    let top = q.top.unwrap_or(50).clamp(1, 500);
    axum::response::Json(
        token_dashboard_core::verbosity::worst(&state.conn(), min_chars, top).unwrap_or_default()
    )
}
```

Register `.route("/api/verbosity", axum::routing::get(get_verbosity))`.

- [ ] **Step 2: Frontend list**

In `prompts.jsx`, add a tab/toggle for "Wasted":

```jsx
function VerbosityList() {
  const [rows, setRows] = useState([]);
  const [minChars, setMinChars] = useState(200);
  useEffect(() => {
    fetch(`/api/verbosity?min_chars=${minChars}&top=50`).then(r=>r.json()).then(setRows);
  }, [minChars]);
  return (
    <div>
      <label>Min prompt chars: <input type="number" value={minChars} onChange={e=>setMinChars(+e.target.value)} /></label>
      <table className="a-table">
        <thead><tr><th>When</th><th>Chars in</th><th>Tokens out</th><th>Ratio</th><th>Preview</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.timestamp.slice(0,16).replace('T',' ')}</td>
              <td>{r.prompt_chars}</td>
              <td>{r.output_tokens}</td>
              <td>{r.ratio.toFixed(1)}</td>
              <td className="a-prompt-preview">{r.preview}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/api-client.js frontend/src/routes/prompts.jsx
git commit -m "feat: verbosity endpoint + prompts tab"
```

---

## Self-Review Notes

- "Ratio" uses chars-vs-tokens. Mixing units, but stable across English/code prompts. If we later have a tokenizer in-tree, switch to tokens-vs-tokens.
- Pair join uses `parent_uuid`. If the scanner stores chains differently (e.g. only the final assistant message points back), test with real data and tweak the join.
