import io
import unittest
import urllib.error
from unittest.mock import patch

from token_dashboard.anthropic_sync import sync_limits


class _FakeResponse:
    def __init__(self, headers):
        self.headers = headers
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b"{}"


class AnthropicSyncTests(unittest.TestCase):
    def test_ok_with_unified_headers(self):
        headers = {
            "anthropic-ratelimit-unified-5h-reset": "1715260320",
            "anthropic-ratelimit-unified-7d-reset": "1715692800",
            "anthropic-ratelimit-requests-remaining": "499",
        }
        with patch("token_dashboard.anthropic_sync.urllib.request.urlopen", return_value=_FakeResponse(headers)):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["five_hour_reset_at"], "2024-05-09T13:12:00Z")
        self.assertEqual(out["weekly_reset_at"], "2024-05-14T13:20:00Z")

    def test_unsupported_when_no_unified_headers(self):
        headers = {"anthropic-ratelimit-requests-remaining": "499"}
        with patch("token_dashboard.anthropic_sync.urllib.request.urlopen", return_value=_FakeResponse(headers)):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "unsupported")
        self.assertIsNone(out["five_hour_reset_at"])
        self.assertIsNone(out["weekly_reset_at"])

    def test_url_error_returned_as_status(self):
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=urllib.error.URLError("boom"),
        ):
            out = sync_limits("sk-ant-test")
        self.assertTrue(out["status"].startswith("error:"))
        self.assertIsNone(out["five_hour_reset_at"])

    def test_http_429_still_parses_headers(self):
        headers = {"anthropic-ratelimit-unified-5h-reset": "1715260320"}
        err = urllib.error.HTTPError(
            url="https://api.anthropic.com/v1/messages",
            code=429, msg="rate limited", hdrs=headers, fp=io.BytesIO(b""),
        )
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=err,
        ):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["five_hour_reset_at"], "2024-05-09T13:12:00Z")

    def test_http_401_returns_error(self):
        err = urllib.error.HTTPError(
            url="https://api.anthropic.com/v1/messages",
            code=401, msg="unauthorized", hdrs={}, fp=io.BytesIO(b""),
        )
        with patch(
            "token_dashboard.anthropic_sync.urllib.request.urlopen",
            side_effect=err,
        ):
            out = sync_limits("sk-ant-test")
        self.assertEqual(out["status"], "error:http 401")


if __name__ == "__main__":
    unittest.main()
