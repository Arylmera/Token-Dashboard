# OS Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire OS-level notifications when monthly budget thresholds are newly crossed. This finishes the deferred half of [02-monthly-budget-alerts.md](./02-monthly-budget-alerts.md). The core check + endpoint already exists from PR #94; this plan adds the Tauri-side wiring.

**Architecture:** The CLI scan loop already runs `core::budget_alerts::check` after each scan completes (added in this plan). It broadcasts an SSE event `budget_alert` on the existing events channel when `newly_crossed` is non-empty. The Tauri shell subscribes to its own embedded server's `/api/stream`, parses `budget_alert` events, and fires one OS notification per newly-crossed threshold via `tauri-plugin-notification`. The CLI crate stays platform-neutral; only the Tauri crate touches the notification surface.

**Tech Stack:** Rust, `tauri-plugin-notification = "2"`, axum SSE (already wired), existing `core::budget_alerts`.

---

## File Structure

- Modify: `crates/token-dashboard-tauri/Cargo.toml` — add `tauri-plugin-notification = "2"`
- Modify: `crates/token-dashboard-tauri/src/main.rs` — register plugin, subscribe to SSE, fire notifications
- Create / modify: `crates/token-dashboard-tauri/capabilities/default.json` — grant `notification:default`
- Modify: `crates/token-dashboard-cli/src/lib.rs` — emit `budget_alert` SSE event after scans

---

### Task 1: Emit `budget_alert` from the CLI scan loop

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Locate the post-scan path**

Open `crates/token-dashboard-cli/src/lib.rs`, find `run_scan_and_broadcast` (around line 485). It already emits an event after `scan_dir` returns. Add a sibling emission right after the existing broadcast.

- [ ] **Step 2: Add the budget-alert check**

Inside `run_scan_and_broadcast`, after the scan broadcast block:

```rust
// Best-effort budget alert dispatch — failure must not abort the scan.
if let Ok(result) = token_dashboard_core::budget_alerts::check(state.db_path.as_ref()) {
    if !result.newly_crossed.is_empty() {
        let _ = state.events.send(serde_json::json!({
            "type": "budget_alert",
            "mtd_cost_usd": result.mtd_cost_usd,
            "monthly_budget_usd": result.monthly_budget_usd,
            "percent": result.percent,
            "newly_crossed": result.newly_crossed,
        }));
    }
}
```

- [ ] **Step 3: Integration test (smoke)**

Add to `crates/token-dashboard-cli/tests/endpoints.rs`:

```rust
#[tokio::test]
async fn scan_publishes_budget_alert_when_threshold_crosses() {
    // Setup AppState pointing at a fresh db with a monthly budget + spend that crosses 50%,
    // subscribe to events, call run_scan_and_broadcast, assert at least one budget_alert event.
}
```

If the existing test harness uses synchronous setup, mirror it; otherwise fall back to a unit-style assertion that simply calls `core::budget_alerts::check` after a fixture scan and confirms `newly_crossed` would have fired.

- [ ] **Step 4: Verify**

```bash
cargo test -p token-dashboard-cli endpoints
```

Expected: pass (or skip with `#[ignore]` if the existing harness doesn't expose what we need; document why).

- [ ] **Step 5: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs crates/token-dashboard-cli/tests/endpoints.rs
git commit -m "feat(cli): emit budget_alert SSE event after scan"
```

---

### Task 2: Add the Tauri notification plugin

**Files:**
- Modify: `crates/token-dashboard-tauri/Cargo.toml`
- Modify: `crates/token-dashboard-tauri/src/main.rs`

- [ ] **Step 1: Add dep**

In `crates/token-dashboard-tauri/Cargo.toml` under `[dependencies]`:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Register plugin**

In `crates/token-dashboard-tauri/src/main.rs`, find the `tauri::Builder::default()` chain (around line 713) and add the plugin **after** `tauri_plugin_single_instance` (which must remain first):

```rust
.plugin(tauri_plugin_notification::init())
```

- [ ] **Step 3: Verify it compiles**

```bash
cargo build -p token-dashboard-tauri
```

Expected: clean. If a capability error pops up at runtime, Task 3 covers it.

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-tauri/Cargo.toml crates/token-dashboard-tauri/src/main.rs
git commit -m "feat(tauri): register tauri-plugin-notification"
```

---

### Task 3: Grant the notification capability

**Files:**
- Find / modify: `crates/token-dashboard-tauri/capabilities/default.json` (or `tauri.conf.json` `app.security.capabilities` block — depends on the existing layout)

- [ ] **Step 1: Locate the existing capability file**

```bash
ls crates/token-dashboard-tauri/capabilities/
# or
grep -r "capabilities" crates/token-dashboard-tauri/
```

If the project uses `capabilities/*.json`, edit `default.json`. If it relies on the inline `tauri.conf.json`, edit there.

- [ ] **Step 2: Add the permission**

In the capability's `permissions` array:

```json
"notification:default"
```

This grants both `is_permission_granted` and `notification:allow-show` to the main window. Tauri 2 denies all plugin calls otherwise.

- [ ] **Step 3: Smoke-test that the plugin handler is registered**

Run the dev shell:

```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

In the devtools console:

```js
await window.__TAURI__.notification.requestPermission();
await window.__TAURI__.notification.sendNotification({ title: "Hi", body: "Test" });
```

Expected: macOS prompts on first run; Windows shows immediately; Linux shows if a daemon is running.

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-tauri/capabilities/default.json
git commit -m "feat(tauri): grant notification:default capability"
```

---

### Task 4: Subscribe to SSE + fire notifications

**Files:**
- Modify: `crates/token-dashboard-tauri/src/main.rs`

- [ ] **Step 1: Add the listener task**

In `main.rs`, after the embedded HTTP server starts (search for where the port is known), spawn a tokio task that connects to `http://127.0.0.1:{port}/api/stream`, parses each line, and fires notifications:

```rust
fn spawn_budget_alert_listener(app: tauri::AppHandle, base_url: String) {
    tauri::async_runtime::spawn(async move {
        let url = format!("{}/api/stream", base_url.trim_end_matches('/'));
        loop {
            match reqwest::get(&url).await {
                Ok(resp) => {
                    use futures::StreamExt;
                    let mut stream = resp.bytes_stream();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break };
                        let text = String::from_utf8_lossy(&bytes);
                        for line in text.lines() {
                            // SSE lines: "data: {json}"
                            let Some(payload) = line.strip_prefix("data: ") else { continue };
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
                            if v.get("type").and_then(|t| t.as_str()) != Some("budget_alert") { continue; }
                            let crossed = v.get("newly_crossed")
                                .and_then(|c| c.as_array())
                                .cloned()
                                .unwrap_or_default();
                            let mtd = v.get("mtd_cost_usd").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let budget = v.get("monthly_budget_usd").and_then(|x| x.as_f64());
                            for t in &crossed {
                                let pct = t.as_u64().unwrap_or(0);
                                let title = format!("Token Dashboard \u{2014} {pct}% of budget");
                                let body = match budget {
                                    Some(b) => format!("${mtd:.2} of ${b:.2} this month"),
                                    None => format!("${mtd:.2} spent this month"),
                                };
                                use tauri_plugin_notification::NotificationExt;
                                let _ = app.notification().builder().title(title).body(body).show();
                            }
                        }
                    }
                }
                Err(_) => {
                    // SSE drop — back off briefly and reconnect.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    });
}
```

Note: `reqwest` may not yet be a Tauri-crate dep. If not, either add it (`reqwest = { version = "0.12", default-features = false, features = ["stream"] }`) or use `ureq` blocking + `tokio::task::spawn_blocking`. Check current Cargo.toml and follow the existing pattern.

- [ ] **Step 2: Call the spawner**

In the `setup` closure of the Tauri builder, after the embedded server's port is determined:

```rust
let url = format!("http://127.0.0.1:{}", port);
spawn_budget_alert_listener(app.handle().clone(), url);
```

- [ ] **Step 3: Manual verification**

```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

Set a tiny monthly budget in Settings, trigger a scan via the menu (or wait for the periodic loop), confirm OS notification appears. Repeat to confirm it does **not** re-fire (state.fired prevents that).

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-tauri/src/main.rs crates/token-dashboard-tauri/Cargo.toml
git commit -m "feat(tauri): fire OS notifications on budget_alert SSE events"
```

---

### Task 5: Document platform behavior

**Files:**
- Modify: `docs/KNOWN_LIMITATIONS.md` (or `docs/PRODUCT.md` — whichever is the user-facing notes file)

- [ ] **Step 1: Add a one-paragraph note**

```markdown
### Budget threshold notifications

- **Windows**: shown immediately as a standard toast.
- **macOS**: first run prompts for notification permission. Decline once and the notification surface stays silent until you re-enable it in System Settings > Notifications > Token Dashboard.
- **Linux**: requires a running notification daemon (most desktop environments ship one). Notifications no-op silently if absent.

To mute a specific threshold, use `POST /api/budget-alerts/config` with `{ "muted": [80] }` (or similar). Settings UI for muting lands with the Budget tab (plan 15).
```

- [ ] **Step 2: Commit**

```bash
git add docs/KNOWN_LIMITATIONS.md
git commit -m "docs: budget notification platform behavior"
```

---

## Self-Review Notes

- The listener uses the embedded server's SSE rather than calling `core::budget_alerts::check` directly from Tauri. That keeps the trigger source-of-truth in one place (the CLI scan loop) and avoids double-firing if both layers were to check independently.
- Reconnect on SSE drop has a fixed 5-second backoff — acceptable; exponential is overkill for a local connection.
- If the user already saw a notification but the Tauri shell wasn't running at the time (e.g. headless CLI mode), they won't see it later. That's acceptable: the banner on Overview covers the "saw on next open" case.
- `notification:default` covers `is_permission_granted`, `request_permission`, and `notification:allow-show` per the plugin docs. Don't widen unnecessarily.
