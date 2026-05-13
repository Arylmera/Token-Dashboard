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
//! - **Linux:** `~/.claude/.credentials.json` (plain JSON file).
//! - **Windows:** Claude Code uses the Windows Credential Manager (wincred);
//!   not yet supported here — caller gets `NotFound`.
//!
//! The stored blob is JSON of shape
//! `{ "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", ... } }`.
//! We never persist the token in our DB; each sync re-reads it so
//! token rotation by Claude Code is picked up automatically.
//!
//! Token refresh is not handled here. An expired access token surfaces
//! as a 401 from the Anthropic call; the user is asked to re-run
//! `claude` so Claude Code itself refreshes.

use serde::Deserialize;

#[derive(Debug)]
pub enum CredentialError {
    /// Credential store has no Claude Code entry — user never logged in,
    /// or this is a platform we don't read from yet (Windows).
    NotFound,
    /// Blob exists but doesn't have the expected JSON shape.
    ParseFailed(String),
    /// Token's `expiresAt` is in the past. Claude Code refreshes the
    /// access token lazily — the user just needs to run `claude` once
    /// to trigger a refresh, then the new token lands in the Keychain.
    Expired { hours_ago: i64 },
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
    /// Anthropic stores expiry as milliseconds since epoch.
    #[serde(rename = "expiresAt")]
    expires_at_ms: Option<i64>,
}

/// Cross-platform: returns the access token for the active Claude Code
/// login. Logs nothing — callers must avoid logging the return value.
/// Returns `Expired` when the token's `expiresAt` is in the past, so
/// callers can give a "run `claude` to refresh" hint without burning
/// an API request.
pub fn read_oauth_token() -> Result<String, CredentialError> {
    let blob = read_credentials_blob()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    parse_access_token(&blob, now_ms)
}

fn parse_access_token(blob: &str, now_ms: i64) -> Result<String, CredentialError> {
    let parsed: CredentialsBlob = serde_json::from_str(blob.trim())
        .map_err(|e| CredentialError::ParseFailed(e.to_string()))?;
    let block = parsed
        .claude_ai_oauth
        .ok_or_else(|| CredentialError::ParseFailed("missing claudeAiOauth".into()))?;
    let token = block
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CredentialError::ParseFailed("missing claudeAiOauth.accessToken".into()))?;
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

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn read_credentials_blob() -> Result<String, CredentialError> {
    let home = std::env::var_os("HOME").ok_or_else(|| CredentialError::Io("no HOME set".into()))?;
    let path = std::path::PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(CredentialError::NotFound),
        Err(e) => Err(CredentialError::Io(e.to_string())),
    }
}

#[cfg(target_os = "windows")]
fn read_credentials_blob() -> Result<String, CredentialError> {
    // Claude Code on Windows uses Credential Manager (wincred). Reading
    // from there isn't wired up yet; surface this as "not found" so the
    // UI shows the "log in with `claude` first" hint rather than an
    // opaque IO error.
    Err(CredentialError::NotFound)
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
}
