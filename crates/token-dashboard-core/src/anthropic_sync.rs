//! One-shot probe of Anthropic's Messages API to read rate-limit headers.
//!
//! Reads the OAuth access token Claude Code stored when the user logged
//! in, sends `Authorization: Bearer` plus the `anthropic-beta:
//! oauth-2025-04-20` header and Claude Code's UA. Counts against the
//! user's subscription (Pro / Max) window — no separate API credits
//! needed. Undocumented / experimental — Anthropic may change or revoke
//! this flow at any time.
//!
//! Returns a populated `SyncResult` carrying utilization (0..1), status,
//! and reset timestamps for the unified 5h and 7d windows when the
//! account exposes them. Accounts that don't expose unified-window
//! headers return `status: "unsupported"`.
//!
//! `ureq` ships with rustls so the binary stays self-contained — no
//! system-OpenSSL dependency. The whole call is synchronous; callers
//! run it inside `tokio::task::spawn_blocking`.

use serde::Serialize;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const PROBE_MODEL: &str = "claude-haiku-4-5-20251001";
const TIMEOUT_S: u64 = 10;

// User-Agent + beta header used by the Claude Code CLI when it calls
// /v1/messages with a subscription OAuth token. Anthropic gates the
// OAuth flow on these headers; sending an arbitrary UA would be
// rejected as "invalid request — oauth tokens require ...".
const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
const OAUTH_USER_AGENT: &str = "claude-code/2.1.5";

const UNIFIED_5H_RESET: &str = "anthropic-ratelimit-unified-5h-reset";
const UNIFIED_5H_UTIL: &str = "anthropic-ratelimit-unified-5h-utilization";
const UNIFIED_5H_STATUS: &str = "anthropic-ratelimit-unified-5h-status";
const UNIFIED_7D_RESET: &str = "anthropic-ratelimit-unified-7d-reset";
const UNIFIED_7D_UTIL: &str = "anthropic-ratelimit-unified-7d-utilization";
const UNIFIED_7D_STATUS: &str = "anthropic-ratelimit-unified-7d-status";

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    /// Call-level status: "ok" when at least one window's headers were
    /// present, "unsupported" when none were, or `error:<reason>` for
    /// transport/HTTP failures.
    pub status: String,
    pub five_hour_reset_at: Option<String>,
    pub weekly_reset_at: Option<String>,
    /// Server-reported utilization for the 5h window, 0..1. None when
    /// the account didn't return the header.
    pub five_hour_utilization: Option<f64>,
    pub weekly_utilization: Option<f64>,
    /// Server-reported per-window status string (e.g. "allowed",
    /// "approaching_limit", "exceeded"). Verbatim from the response.
    pub five_hour_status: Option<String>,
    pub weekly_status: Option<String>,
}

impl SyncResult {
    fn error(reason: String) -> Self {
        Self {
            status: format!("error:{reason}"),
            five_hour_reset_at: None,
            weekly_reset_at: None,
            five_hour_utilization: None,
            weekly_utilization: None,
            five_hour_status: None,
            weekly_status: None,
        }
    }
}

fn unix_to_iso(value: &str) -> Option<String> {
    let secs: i64 = value.trim().parse().ok()?;
    Some(iso_from_unix(secs))
}

fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
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

fn parse_util(value: &str) -> Option<f64> {
    value.trim().parse::<f64>().ok().map(|v| v.clamp(0.0, 1.0))
}

#[cfg(feature = "http")]
pub fn sync_limits_oauth(access_token: &str) -> SyncResult {
    use std::time::Duration;

    let body = serde_json::json!({
        "model": PROBE_MODEL,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}]
    });

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(TIMEOUT_S))
        .build();
    let req = agent
        .post(ENDPOINT)
        .set("anthropic-version", ANTHROPIC_VERSION)
        .set("content-type", "application/json")
        .set("authorization", &format!("Bearer {access_token}"))
        .set("anthropic-beta", OAUTH_BETA_HEADER)
        .set("user-agent", OAUTH_USER_AGENT);

    let (headers, error_status) = match req.send_json(body) {
        Ok(resp) => (collect_headers(&resp), None),
        Err(ureq::Error::Status(code, resp)) => {
            let h = collect_headers(&resp);
            // 429 is fine — rate-limit headers are still present.
            let err = if code == 429 {
                None
            } else {
                // Surface a short snippet of the response body so the
                // user can see Anthropic's actual reason (e.g. "OAuth
                // authentication failed", "this beta is no longer
                // available"). Cap to 200 chars to avoid leaking
                // arbitrary bytes into the UI.
                let body = resp.into_string().unwrap_or_default();
                let snippet: String = body
                    .chars()
                    .take(200)
                    .collect::<String>()
                    .replace('\n', " ");
                Some(if snippet.is_empty() {
                    format!("error:http {code}")
                } else {
                    format!("error:http {code} {snippet}")
                })
            };
            (h, err)
        }
        Err(e) => {
            return SyncResult::error(classify_error(&e).into());
        }
    };

    parse_headers(&headers, error_status)
}

fn parse_headers(
    headers: &std::collections::HashMap<String, String>,
    error_status: Option<String>,
) -> SyncResult {
    let five_reset = headers.get(UNIFIED_5H_RESET).and_then(|v| unix_to_iso(v));
    let week_reset = headers.get(UNIFIED_7D_RESET).and_then(|v| unix_to_iso(v));
    let five_util = headers.get(UNIFIED_5H_UTIL).and_then(|v| parse_util(v));
    let week_util = headers.get(UNIFIED_7D_UTIL).and_then(|v| parse_util(v));
    let five_status = headers.get(UNIFIED_5H_STATUS).cloned();
    let week_status = headers.get(UNIFIED_7D_STATUS).cloned();

    let nothing_present =
        five_reset.is_none() && week_reset.is_none() && five_util.is_none() && week_util.is_none();
    if nothing_present {
        return SyncResult {
            status: error_status.unwrap_or_else(|| "unsupported".into()),
            five_hour_reset_at: None,
            weekly_reset_at: None,
            five_hour_utilization: None,
            weekly_utilization: None,
            five_hour_status: None,
            weekly_status: None,
        };
    }

    SyncResult {
        status: "ok".into(),
        five_hour_reset_at: five_reset,
        weekly_reset_at: week_reset,
        five_hour_utilization: five_util,
        weekly_utilization: week_util,
        five_hour_status: five_status,
        weekly_status: week_status,
    }
}

#[cfg(not(feature = "http"))]
pub fn sync_limits_oauth(_access_token: &str) -> SyncResult {
    SyncResult::error("http feature disabled".into())
}

#[cfg(feature = "http")]
fn collect_headers(resp: &ureq::Response) -> std::collections::HashMap<String, String> {
    resp.headers_names()
        .into_iter()
        .filter_map(|n| {
            let lower = n.to_lowercase();
            resp.header(&n).map(|v| (lower, v.to_string()))
        })
        .collect()
}

#[cfg(feature = "http")]
fn classify_error(e: &ureq::Error) -> &'static str {
    match e {
        ureq::Error::Status(_, _) => "HTTPError",
        ureq::Error::Transport(t) => match t.kind() {
            ureq::ErrorKind::ConnectionFailed => "ConnectionError",
            ureq::ErrorKind::Dns => "DNSError",
            ureq::ErrorKind::Io => "IOError",
            _ => "TransportError",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn unix_iso_round_trip() {
        assert_eq!(
            unix_to_iso("1746000000"),
            Some("2025-04-30T08:00:00Z".into())
        );
    }

    #[test]
    fn iso_from_unix_zero() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn unix_to_iso_invalid_input() {
        assert!(unix_to_iso("nope").is_none());
        assert!(unix_to_iso("").is_none());
    }

    #[test]
    fn parses_full_header_set() {
        let mut h: HashMap<String, String> = HashMap::new();
        h.insert(UNIFIED_5H_RESET.into(), "1746000000".into());
        h.insert(UNIFIED_5H_UTIL.into(), "0.42".into());
        h.insert(UNIFIED_5H_STATUS.into(), "allowed".into());
        h.insert(UNIFIED_7D_RESET.into(), "1746500000".into());
        h.insert(UNIFIED_7D_UTIL.into(), "0.18".into());
        h.insert(UNIFIED_7D_STATUS.into(), "allowed".into());
        let r = parse_headers(&h, None);
        assert_eq!(r.status, "ok");
        assert_eq!(r.five_hour_utilization, Some(0.42));
        assert_eq!(r.weekly_utilization, Some(0.18));
        assert_eq!(r.five_hour_status.as_deref(), Some("allowed"));
        assert!(r.five_hour_reset_at.is_some());
        assert!(r.weekly_reset_at.is_some());
    }

    #[test]
    fn util_value_clamped_to_unit() {
        // Headers should always be 0..1 but be defensive.
        assert_eq!(parse_util("1.4"), Some(1.0));
        assert_eq!(parse_util("-0.2"), Some(0.0));
        assert_eq!(parse_util("0.5"), Some(0.5));
    }

    #[test]
    fn empty_headers_yield_unsupported() {
        let r = parse_headers(&HashMap::new(), None);
        assert_eq!(r.status, "unsupported");
        assert!(r.five_hour_utilization.is_none());
    }

    #[test]
    fn http_error_passthrough_when_no_headers() {
        let r = parse_headers(&HashMap::new(), Some("error:http 401".into()));
        assert_eq!(r.status, "error:http 401");
    }

    #[test]
    fn util_only_no_reset_still_ok() {
        let mut h: HashMap<String, String> = HashMap::new();
        h.insert(UNIFIED_5H_UTIL.into(), "0.10".into());
        let r = parse_headers(&h, None);
        assert_eq!(r.status, "ok");
        assert_eq!(r.five_hour_utilization, Some(0.10));
    }
}
