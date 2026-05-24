//! Reads the Claude Code OAuth access token used by the OAuth-sourced
//! limits sync. Only `anthropic_sync::sync_limits_oauth` calls this —
//! the JSONL ingest path does not.
//!
//! Storage location depends on platform:
//! - **macOS:** generic-password keychain item `Claude Code-credentials`.
//!   First read prompts the user; granting "Always Allow" makes
//!   subsequent reads silent. The ACL is bound to the requesting
//!   binary's signature — unsigned dev builds and signed release builds
//!   each prompt once.
//! - **Linux / Windows:** `~/.claude/.credentials.json` (plain JSON file).
//!   Resolved via `HOME` (set on *nix; some Windows shells set it too)
//!   with a `USERPROFILE` fallback for native Windows.
//!
//! The stored blob is JSON of shape
//! `{ "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", ... } }`.
//! We never persist the token in our DB; each sync re-reads it so
//! token rotation by Claude Code is picked up automatically.
//!
//! When the stored access token is expired we refresh it via the OAuth
//! refresh token and write the rotated tokens back to the credential
//! file (Linux/Windows), so subsequent syncs — and Claude Code itself —
//! keep working without a manual `claude` re-login. See
//! `persist_refreshed_tokens`.

use serde::Deserialize;

#[derive(Debug)]
pub enum CredentialError {
    /// Credential store has no Claude Code entry — user never logged in.
    NotFound,
    /// Blob exists but doesn't have the expected JSON shape.
    ParseFailed(String),
    /// Token's `expiresAt` is in the past. Claude Code refreshes the
    /// access token lazily — the user just needs to run `claude` once
    /// to trigger a refresh, then the new token lands in the Keychain.
    Expired {
        hours_ago: i64,
    },
    /// Platform store rejected the read (keychain prompt denied, file
    /// permission error, etc).
    AccessDenied(String),
    Io(String),
}

impl CredentialError {
    pub fn user_message(&self) -> String {
        match self {
            Self::NotFound => {
                "no Claude Code credentials found — log in with `claude` first".into()
            }
            Self::ParseFailed(e) => format!("credentials format unexpected: {e}"),
            Self::Expired { hours_ago } => format!(
                "Claude Code token expired {hours_ago}h ago — run `claude` once to refresh, then try again"
            ),
            Self::AccessDenied(e) => format!("credentials access denied: {e}"),
            Self::Io(e) => format!("credentials io error: {e}"),
        }
    }
}

#[derive(Deserialize)]
struct CredentialsBlob {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OAuthBlock>,
}

#[derive(Deserialize)]
struct OAuthBlock {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    /// Anthropic stores expiry as milliseconds since epoch.
    #[serde(rename = "expiresAt")]
    expires_at_ms: Option<i64>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
}

/// Public client_id and refresh endpoint Claude Code uses. Extracted
/// from the official Claude Code binary (v2.1.92). Static — Anthropic
/// can rotate these but does so rarely; if a refresh starts failing
/// across the board we'd update both here.
const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REFRESH_TIMEOUT_S: u64 = 15;

/// Cross-platform: returns the access token for the active Claude Code
/// login, refreshing it via the OAuth refresh token if the stored one
/// is expired. Logs nothing — callers must avoid logging the return
/// value.
///
/// Anthropic rotates the refresh token on every use (standard OAuth),
/// so a refresh both mints a new access token and invalidates the old
/// refresh token server-side. On Linux/Windows we therefore write the
/// rotated `accessToken`/`refreshToken`/`expiresAt` back to
/// `~/.claude/.credentials.json`, keeping both this tool and Claude
/// Code working off valid tokens. Without the write-back the next
/// sync would send the now-dead refresh token, fail, and force the
/// user to run `claude` to re-mint credentials — the very loop this
/// avoids. On macOS we skip the write-back: a Keychain *write* would
/// pop a permission prompt, so the refreshed token only services the
/// current call there.
pub fn read_oauth_token() -> Result<String, CredentialError> {
    let blob = read_credentials_blob()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let block = parse_oauth_block(&blob)?;
    match access_token_if_fresh(&block, now_ms) {
        Ok(token) => Ok(token),
        Err(CredentialError::Expired { hours_ago }) => {
            // Try to refresh in-memory. If we don't have a refresh
            // token or the refresh fails, surface the original
            // Expired error so the UI shows the "run `claude`" hint.
            let refresh_token = block
                .refresh_token
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or(CredentialError::Expired { hours_ago })?;
            refresh_oauth_token(refresh_token, block.scopes.as_deref())
                .map_err(|_| CredentialError::Expired { hours_ago })
        }
        Err(other) => Err(other),
    }
}

/// Lower-level probe: returns true if the credential store has a
/// usable login (either a fresh access token or a refresh token we
/// could use to mint one). Used by `/api/limits/oauth_status` so the
/// Settings toggle doesn't disappear just because the access token is
/// briefly stale — we'd refresh it on demand anyway.
pub fn has_usable_oauth() -> Result<bool, CredentialError> {
    let blob = read_credentials_blob()?;
    let block = parse_oauth_block(&blob)?;
    let has_refresh = block
        .refresh_token
        .as_deref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let access_fresh = access_token_if_fresh(&block, now_ms).is_ok();
    Ok(access_fresh || has_refresh)
}

fn parse_oauth_block(blob: &str) -> Result<OAuthBlock, CredentialError> {
    let parsed: CredentialsBlob = serde_json::from_str(blob.trim())
        .map_err(|e| CredentialError::ParseFailed(e.to_string()))?;
    parsed
        .claude_ai_oauth
        .ok_or_else(|| CredentialError::ParseFailed("missing claudeAiOauth".into()))
}

fn access_token_if_fresh(block: &OAuthBlock, now_ms: i64) -> Result<String, CredentialError> {
    let token = block
        .access_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CredentialError::ParseFailed("missing claudeAiOauth.accessToken".into()))?
        .to_string();
    if let Some(exp) = block.expires_at_ms {
        // Treat anything within the next 60s as also expired — the call
        // takes a few seconds and we'd rather report Expired up-front
        // than chase a race-conditioned 401.
        if exp <= now_ms + 60_000 {
            let hours_ago = ((now_ms - exp) / 3_600_000).max(0);
            return Err(CredentialError::Expired { hours_ago });
        }
    }
    Ok(token)
}

#[cfg(test)]
fn parse_access_token(blob: &str, now_ms: i64) -> Result<String, CredentialError> {
    let block = parse_oauth_block(blob)?;
    access_token_if_fresh(&block, now_ms)
}

/// Default scopes Claude Code requests when it first authorizes. We
/// fall back to these when the stored credential blob doesn't list
/// scopes, matching what the CLI itself would send.
const DEFAULT_OAUTH_SCOPES: &[&str] = &[
    "user:inference",
    "user:profile",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: Option<String>,
    /// Rotated refresh token. Anthropic issues a fresh one on every
    /// refresh and invalidates the prior one — we must persist this.
    refresh_token: Option<String>,
    /// Lifetime of the new access token, in seconds.
    expires_in: Option<i64>,
}

#[cfg(feature = "http")]
fn refresh_oauth_token(
    refresh_token: &str,
    stored_scopes: Option<&[String]>,
) -> Result<String, CredentialError> {
    use std::time::Duration;
    let scope = match stored_scopes {
        Some(s) if !s.is_empty() => s.join(" "),
        _ => DEFAULT_OAUTH_SCOPES.join(" "),
    };
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": OAUTH_CLIENT_ID,
        "scope": scope,
    });
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(OAUTH_REFRESH_TIMEOUT_S))
        .build();
    let resp = agent
        .post(OAUTH_TOKEN_URL)
        .set("content-type", "application/json")
        .send_json(body)
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                CredentialError::AccessDenied(format!("refresh http {code}"))
            }
            ureq::Error::Transport(t) => CredentialError::Io(t.to_string()),
        })?;
    let parsed: RefreshResponse = resp
        .into_json()
        .map_err(|e| CredentialError::ParseFailed(format!("refresh response: {e}")))?;
    let access = parsed
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CredentialError::ParseFailed("refresh response missing access_token".into())
        })?;
    // Persist the rotated tokens so the next sync (and Claude Code) keeps
    // working. Best-effort: a write failure must not fail this sync — the
    // returned `access` still services the current call.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let new_expires_at_ms = parsed.expires_in.map(|secs| now_ms + secs * 1000);
    persist_refreshed_tokens(&access, parsed.refresh_token.as_deref(), new_expires_at_ms);
    Ok(access)
}

/// Write the freshly-minted tokens back to `~/.claude/.credentials.json`,
/// preserving every other field in the blob. Best-effort and silent: any
/// failure leaves the file untouched and the caller's in-memory token is
/// still valid for the current request.
#[cfg(all(feature = "http", not(target_os = "macos")))]
fn persist_refreshed_tokens(access: &str, refresh: Option<&str>, expires_at_ms: Option<i64>) {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return;
    };
    let path = std::path::PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return;
    };
    let Some(oauth) = root
        .get_mut("claudeAiOauth")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    oauth.insert(
        "accessToken".into(),
        serde_json::Value::String(access.to_string()),
    );
    if let Some(r) = refresh {
        oauth.insert(
            "refreshToken".into(),
            serde_json::Value::String(r.to_string()),
        );
    }
    if let Some(e) = expires_at_ms {
        oauth.insert("expiresAt".into(), serde_json::Value::Number(e.into()));
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&root) {
        let _ = std::fs::write(&path, serialized);
    }
}

/// macOS keeps credentials in the Keychain; a write-back would trigger a
/// permission prompt and can race Claude Code's own refresh, so we skip
/// it. The in-memory token still services the current sync.
#[cfg(all(feature = "http", target_os = "macos"))]
fn persist_refreshed_tokens(_access: &str, _refresh: Option<&str>, _expires_at_ms: Option<i64>) {}

#[cfg(not(feature = "http"))]
fn refresh_oauth_token(
    _refresh_token: &str,
    _stored_scopes: Option<&[String]>,
) -> Result<String, CredentialError> {
    Err(CredentialError::Io("http feature disabled".into()))
}

#[cfg(target_os = "macos")]
fn read_credentials_blob() -> Result<String, CredentialError> {
    use std::process::Command;
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| CredentialError::Io(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("could not be found") {
            return Err(CredentialError::NotFound);
        }
        return Err(CredentialError::AccessDenied(if stderr.is_empty() {
            "security exited non-zero".into()
        } else {
            stderr
        }));
    }
    String::from_utf8(output.stdout).map_err(|e| CredentialError::ParseFailed(e.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn read_credentials_blob() -> Result<String, CredentialError> {
    // Claude Code writes `.credentials.json` under `~/.claude/` on both
    // Linux and Windows. Prefer `HOME` (set on *nix and Git-Bash / WSL),
    // fall back to `USERPROFILE` for native Windows shells.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| CredentialError::Io("no HOME or USERPROFILE set".into()))?;
    let path = std::path::PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(CredentialError::NotFound),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(CredentialError::AccessDenied(e.to_string()))
        }
        Err(e) => Err(CredentialError::Io(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-05-13T12:00:00Z in milliseconds; tests use this as "now".
    const NOW_MS: i64 = 1_778_760_000_000;

    #[test]
    fn parses_well_formed_blob_with_future_expiry() {
        let blob = format!(
            r#"{{
                "claudeAiOauth": {{
                    "accessToken": "sk-ant-oat01-EXAMPLE",
                    "expiresAt": {}
                }}
            }}"#,
            NOW_MS + 3_600_000
        );
        assert_eq!(
            parse_access_token(&blob, NOW_MS).unwrap(),
            "sk-ant-oat01-EXAMPLE".to_string()
        );
    }

    #[test]
    fn parses_blob_without_expiry_field() {
        let blob = r#"{ "claudeAiOauth": { "accessToken": "sk-ant-oat01-EXAMPLE" } }"#;
        assert_eq!(
            parse_access_token(blob, NOW_MS).unwrap(),
            "sk-ant-oat01-EXAMPLE".to_string()
        );
    }

    #[test]
    fn detects_expired_token() {
        let blob = format!(
            r#"{{ "claudeAiOauth": {{ "accessToken": "x", "expiresAt": {} }} }}"#,
            NOW_MS - 23 * 24 * 3_600_000
        );
        match parse_access_token(&blob, NOW_MS) {
            Err(CredentialError::Expired { hours_ago }) => assert_eq!(hours_ago, 552),
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_token() {
        let blob = r#"{ "claudeAiOauth": { "refreshToken": "x" } }"#;
        match parse_access_token(blob, NOW_MS) {
            Err(CredentialError::ParseFailed(_)) => {}
            other => panic!("expected ParseFailed, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_token() {
        let blob = r#"{ "claudeAiOauth": { "accessToken": "" } }"#;
        assert!(matches!(
            parse_access_token(blob, NOW_MS),
            Err(CredentialError::ParseFailed(_))
        ));
    }

    #[test]
    fn rejects_garbage_json() {
        assert!(matches!(
            parse_access_token("not-json", NOW_MS),
            Err(CredentialError::ParseFailed(_))
        ));
    }

    #[test]
    fn rejects_wrong_top_level_key() {
        let blob = r#"{ "something_else": { "accessToken": "x" } }"#;
        assert!(matches!(
            parse_access_token(blob, NOW_MS),
            Err(CredentialError::ParseFailed(_))
        ));
    }

    #[test]
    fn parses_refresh_token_alongside_access() {
        let blob = r#"{ "claudeAiOauth": { "accessToken": "a", "refreshToken": "r", "scopes": ["user:inference"] } }"#;
        let block = parse_oauth_block(blob).unwrap();
        assert_eq!(block.access_token.as_deref(), Some("a"));
        assert_eq!(block.refresh_token.as_deref(), Some("r"));
        assert_eq!(
            block.scopes.as_deref(),
            Some(&["user:inference".to_string()][..])
        );
    }

    #[test]
    fn access_token_if_fresh_returns_token_when_unexpired() {
        let block = OAuthBlock {
            access_token: Some("a".into()),
            refresh_token: None,
            expires_at_ms: Some(NOW_MS + 3_600_000),
            scopes: None,
        };
        assert_eq!(access_token_if_fresh(&block, NOW_MS).unwrap(), "a");
    }

    #[test]
    fn access_token_if_fresh_returns_expired_when_stale() {
        let block = OAuthBlock {
            access_token: Some("a".into()),
            refresh_token: None,
            expires_at_ms: Some(NOW_MS - 3_600_000),
            scopes: None,
        };
        assert!(matches!(
            access_token_if_fresh(&block, NOW_MS),
            Err(CredentialError::Expired { hours_ago: 1 })
        ));
    }

    #[cfg(all(feature = "http", not(target_os = "macos")))]
    #[test]
    fn persist_rewrites_tokens_and_keeps_other_fields() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let cred = claude.join(".credentials.json");
        let mut f = std::fs::File::create(&cred).unwrap();
        f.write_all(
            br#"{"claudeAiOauth":{"accessToken":"old-access","refreshToken":"old-refresh","expiresAt":1,"subscriptionType":"max"}}"#,
        )
        .unwrap();
        drop(f);

        // persist_refreshed_tokens resolves the file via HOME/USERPROFILE.
        let prev_home = std::env::var_os("HOME");
        let prev_profile = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", dir.path());
        std::env::set_var("USERPROFILE", dir.path());

        persist_refreshed_tokens("new-access", Some("new-refresh"), Some(999));

        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match prev_profile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cred).unwrap()).unwrap();
        let o = &written["claudeAiOauth"];
        assert_eq!(o["accessToken"], "new-access");
        assert_eq!(o["refreshToken"], "new-refresh");
        assert_eq!(o["expiresAt"], 999);
        // Unrelated fields survive the rewrite.
        assert_eq!(o["subscriptionType"], "max");
    }
}
