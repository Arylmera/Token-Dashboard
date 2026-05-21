import React, { useEffect } from "react";
import { applyThemeClass, themeIndexFromId, themeIndexFromStorage } from "./theme.js";

const closeSelf = () => {
  try {
    const t = window.__TAURI__;
    const win = t && t.window && t.window.getCurrentWindow
      ? t.window.getCurrentWindow()
      : null;
    if (win) { win.close(); return; }
  } catch (_) { /* fall through */ }
  try { window.close(); } catch (_) {}
};

export const SetupHelpContent = ({ onClose }) => (
  <div className="a-setup-help">
    <div className="a-setup-help-head" data-tauri-drag-region>
      <h3>Remote machine setup</h3>
      <button type="button" className="a-pill-btn" onClick={onClose}>close</button>
    </div>
    <div className="a-setup-help-body">
      <p>
        Token Dashboard can pull read-only snapshots from <em>other</em> machines
        running the same dashboard. Set up the <strong>host</strong> first, then
        register it on the <strong>viewer</strong>.
      </p>

      <h4>1 · On the host machine (the one you want to read from)</h4>
      <ol>
        <li>Install Token Dashboard and let it scan once so the local DB exists.</li>
        <li>
          Pick a secret bearer token (any random string, e.g.
          <code> openssl rand -hex 32</code>) and export it before launching:
        </li>
      </ol>
      <pre className="a-pre">{`# macOS / Linux
export TOKEN_DASHBOARD_SYNC_TOKEN="paste-your-secret-here"
token-dashboard            # or launch the Tauri app

# Windows PowerShell
$env:TOKEN_DASHBOARD_SYNC_TOKEN = "paste-your-secret-here"
token-dashboard.exe`}</pre>
      <ol start={3}>
        <li>
          Make the host reachable from the viewer:
          same LAN → use the host's LAN IP and port <code>8080</code>;
          remote network → SSH port-forward or a Tailscale/WireGuard tunnel.
          Never expose the port directly to the public internet.
        </li>
        <li>
          Confirm the snapshot endpoint responds:
          <pre className="a-pre">{`curl -H "Authorization: Bearer paste-your-secret-here" \\
     http://HOST-IP:8080/api/sync/snapshot | head -c 200`}</pre>
        </li>
      </ol>

      <h4>2 · On this (viewer) machine</h4>
      <ol>
        <li><strong>Label</strong> — short name, e.g. <code>laptop</code> or <code>desktop</code>.</li>
        <li><strong>URL</strong> — host base URL including port, e.g. <code>http://192.168.1.42:8080</code>.</li>
        <li><strong>Bearer token</strong> — the exact same string you set on the host.</li>
        <li>Click <strong>Add</strong>, then <strong>sync</strong> to pull the first snapshot.</li>
      </ol>

      <h4>How sync works under the hood</h4>
      <ol>
        <li>
          <strong>Trigger.</strong> Clicking <em>sync</em> in the table calls
          <code> POST /api/remote-sources/:id/sync </code> on the viewer's own
          local Axum router. The handler runs inside
          <code> tokio::spawn_blocking </code> so the outbound HTTP call doesn't
          tie up the async runtime.
        </li>
        <li>
          <strong>Lookup.</strong> The handler reads the source row from the
          local <code>remote_sources</code> table (label, base URL, bearer).
          Disabled sources short-circuit with an error.
        </li>
        <li>
          <strong>Outbound request.</strong> Built with the
          <code> ureq </code> blocking client, 60 s timeout:
          <pre className="a-pre">{`let url = format!("{}/api/sync/snapshot",
                  row.base_url.trim_end_matches('/'));
let mut req = ureq::get(&url).timeout(Duration::from_secs(60));
if let Some(bearer) = row.bearer.as_deref() {
    req = req.set("Authorization",
                  &format!("Bearer {}", bearer));
}
let snap: Snapshot = req.call()?.into_json()?;`}</pre>
          Plain HTTP GET, single round-trip, JSON body — no streaming, no
          WebSocket. The viewer relies on <code>INSERT OR IGNORE</code> for
          idempotency rather than a server-side <code>since</code> cursor, so
          every pull fetches the host's full snapshot.
        </li>
        <li>
          <strong>Auth on the host.</strong> The host's
          <code> /api/sync/snapshot </code> handler reads
          <code> Authorization: Bearer … </code> and compares it to
          <code> TOKEN_DASHBOARD_SYNC_TOKEN </code> from the host's env
          (constant-time compare). Missing or mismatched → <code>401</code>.
        </li>
        <li>
          <strong>Merge.</strong> The JSON deserialises into
          <code> Snapshot {`{ messages, tool_calls }`}</code> — numeric fields
          and identifiers only, prompt text is intentionally omitted.
          <code> sync_snapshot::merge() </code> opens the local DB and runs
          <code> INSERT OR IGNORE </code> row-by-row, keyed on
          <code> messages.uuid </code> and
          <code> (message_uuid, tool_name, target, use_id, timestamp) </code>
          on tool calls.
        </li>
        <li>
          <strong>Bookkeeping.</strong> On success,
          <code> remote_sources::stamp_sync(path, id, None) </code> writes
          <code> last_sync_at = now </code>. On failure, the same call stashes
          the error string in <code>last_error</code> so the UI can surface it,
          and the next sync retries from scratch.
        </li>
      </ol>

      <h4>Network reachability is your problem</h4>
      <p>
        <code>ureq</code> just does TCP → HTTP — same-LAN works out of the
        box. Anything cross-network needs you to set up the tunnel yourself
        (Tailscale, WireGuard, SSH <code>-L</code>). There's no NAT punching,
        STUN, or rendezvous server in the binary; the viewer only knows how
        to dial the URL you gave it.
      </p>

      <h4>Notes</h4>
      <ul>
        <li><strong>One-way + read-only.</strong> The host is unaware of viewers; nothing flows back upstream.</li>
        <li><strong>Manual triggers only.</strong> There's no background pull — click <em>sync</em> when you want fresh rows. Disable a source to pause it without losing the bearer.</li>
        <li><strong>Token storage.</strong> Bearer tokens live in the viewer's local SQLite (<code>~/.claude/token-dashboard.db</code>, <code>remote_sources</code> table) and are stripped from API responses so they never round-trip to the UI.</li>
        <li><strong>Rotation.</strong> Restart the host with a new <code>TOKEN_DASHBOARD_SYNC_TOKEN</code> and update the entry here (delete + re-add). Old viewers start failing immediately; the new token is picked up on the next manual sync.</li>
        <li><strong>Two viewers, same host.</strong> Fine — both pull the same snapshot independently; dedup keys keep each viewer's DB consistent.</li>
      </ul>
    </div>
  </div>
);

// Mirror the widget: apply the theme stored in localStorage on mount,
// then re-apply whenever the main shell pushes a `td:theme` event after
// the user switches themes there. localStorage is shared across same-
// origin webview windows, so the value is always current at mount time.
const useThemeSync = () => {
  useEffect(() => {
    try { applyThemeClass(themeIndexFromStorage()); } catch (_) {}
    const onTheme = (e) => {
      try {
        const idx = e && e.detail && e.detail.theme
          ? themeIndexFromId(e.detail.theme)
          : themeIndexFromStorage();
        if (idx >= 0) applyThemeClass(idx);
      } catch (_) {}
    };
    const onStorage = (e) => {
      if (e.key && e.key.startsWith("td.theme")) {
        try { applyThemeClass(themeIndexFromStorage()); } catch (_) {}
      }
    };
    window.addEventListener("td:theme", onTheme);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("td:theme", onTheme);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
};

export const SetupHelpWindow = () => {
  useThemeSync();
  return (
    <div className="dir-a-root a-setup-help-root" style={{ height: "100vh" }}>
      <SetupHelpContent onClose={closeSelf} />
    </div>
  );
};
