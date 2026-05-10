//! One-shot probe of Anthropic's Messages API to read rate-limit headers.
//!
//! Direct port of `token_dashboard/anthropic_sync.py`. Used by the
//! user-initiated `POST /api/limits/sync` route. The unified 5h/7d
//! reset headers appear on accounts on usage-based limits (Max plan /
//! Claude Code subscriptions); other accounts get `status: "unsupported"`.
//!
//! `ureq` ships with rustls so the binary stays self-contained — no
//! system-OpenSSL dependency. The whole call is synchronous; callers
//! run it inside `tokio::task::spawn_blocking`.

use serde::Serialize;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const PROBE_MODEL: &str = "claude-haiku-4-5-20251001";
const TIMEOUT_S: u64 = 10;

const UNIFIED_5H_HEADER: &str = "anthropic-ratelimit-unified-5h-reset";
const UNIFIED_7D_HEADER: &str = "anthropic-ratelimit-unified-7d-reset";

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub status: String,
    pub five_hour_reset_at: Option<String>,
    pub weekly_reset_at: Option<String>,
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

#[cfg(feature = "http")]
pub fn sync_limits(api_key: &str) -> SyncResult {
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
        .set("x-api-key", api_key)
        .set("anthropic-version", ANTHROPIC_VERSION)
        .set("content-type", "application/json");

    let (headers, error_status) = match req.send_json(body) {
        Ok(resp) => (collect_headers(&resp), None),
        Err(ureq::Error::Status(code, resp)) => {
            let h = collect_headers(&resp);
            let err = if code == 429 {
                None
            } else {
                Some(format!("error:http {code}"))
            };
            (h, err)
        }
        Err(e) => {
            return SyncResult {
                status: format!("error:{}", classify_error(&e)),
                five_hour_reset_at: None,
                weekly_reset_at: None,
            };
        }
    };

    let five = headers.get(UNIFIED_5H_HEADER).and_then(|v| unix_to_iso(v));
    let week = headers.get(UNIFIED_7D_HEADER).and_then(|v| unix_to_iso(v));

    if five.is_none() && week.is_none() {
        return SyncResult {
            status: error_status.unwrap_or_else(|| "unsupported".into()),
            five_hour_reset_at: None,
            weekly_reset_at: None,
        };
    }

    SyncResult {
        status: "ok".into(),
        five_hour_reset_at: five,
        weekly_reset_at: week,
    }
}

#[cfg(not(feature = "http"))]
pub fn sync_limits(_api_key: &str) -> SyncResult {
    SyncResult {
        status: "error:http feature disabled".into(),
        five_hour_reset_at: None,
        weekly_reset_at: None,
    }
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

    #[test]
    fn unix_iso_round_trip() {
        // 1746000000 = 2025-04-30T08:00:00Z
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
}
