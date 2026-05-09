"""One-shot probe of Anthropic's Messages API to read rate-limit headers.

Stdlib-only. Used by the user-initiated `POST /api/limits/sync` route. The
unified 5h/7d reset headers only appear on accounts on usage-based limits
(Max plan / Claude Code subscriptions); on other accounts we report
`unsupported` and leave the manually-entered reset values alone.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
PROBE_MODEL = "claude-haiku-4-5-20251001"
TIMEOUT_S = 10

UNIFIED_5H_HEADER = "anthropic-ratelimit-unified-5h-reset"
UNIFIED_7D_HEADER = "anthropic-ratelimit-unified-7d-reset"


def _unix_to_iso(value) -> "str | None":
    if value is None:
        return None
    try:
        secs = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return (
        datetime.fromtimestamp(secs, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _lower_headers(hdrs) -> dict:
    if not hdrs:
        return {}
    if hasattr(hdrs, "items"):
        return {str(k).lower(): str(v) for k, v in hdrs.items()}
    return {str(k).lower(): str(v) for k, v in (hdrs or [])}


def sync_limits(api_key: str) -> dict:
    body = json.dumps({
        "model": PROBE_MODEL,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
    )
    headers: dict = {}
    error_status: "str | None" = None
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            headers = _lower_headers(resp.headers)
            try:
                resp.read()
            except Exception:
                pass
    except urllib.error.HTTPError as e:
        headers = _lower_headers(e.headers)
        if e.code != 429:
            error_status = f"error:http {e.code}"
    except Exception as e:
        return {
            "status": f"error:{type(e).__name__}",
            "five_hour_reset_at": None,
            "weekly_reset_at": None,
        }

    five = _unix_to_iso(headers.get(UNIFIED_5H_HEADER))
    week = _unix_to_iso(headers.get(UNIFIED_7D_HEADER))

    if five is None and week is None:
        return {
            "status": error_status or "unsupported",
            "five_hour_reset_at": None,
            "weekly_reset_at": None,
        }

    return {
        "status": "ok",
        "five_hour_reset_at": five,
        "weekly_reset_at": week,
    }
