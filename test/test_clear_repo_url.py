import json
import os
import subprocess
import sys
import unittest
import urllib.error
from io import StringIO
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

try:
    import clear_repo_url
    PLAYWRIGHT_AVAILABLE = True
except ModuleNotFoundError as error:
    if error.name != "playwright":
        raise
    PLAYWRIGHT_AVAILABLE = False


class MockClock:
    """Return the supplied timestamps, then repeat the last timestamp."""

    def __init__(self, times):
        self.times = iter(times)
        self.last = 0

    def __call__(self):
        self.last = next(self.times, self.last)
        return self.last


def _make_response(body):
    response = MagicMock()
    response.read.return_value = json.dumps(body).encode("utf-8")
    response.__enter__.return_value = response
    return response


def _env():
    return {
        "GH_TOKEN": "test-token",
        "GITHUB_REPOSITORY": "owner/repo",
        "GITHUB_RUN_ID": "100",
        "GITHUB_WORKFLOW": "Clear Repo URL",
    }


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed in the Python environment")
class TestClearHomepage(unittest.TestCase):
    def setUp(self):
        def mock_target(target, **kwargs):
            patcher = patch(target, **kwargs)
            mock = patcher.start()
            self.addCleanup(patcher.stop)
            return mock

        self.clock = mock_target("clear_repo_url.time.time", side_effect=MockClock([0, 0, 121]))
        self.sleep = mock_target("clear_repo_url.time.sleep")
        self.urlopen = mock_target("clear_repo_url.urllib.request.urlopen")
        self.playwright = mock_target("clear_repo_url.sync_playwright")
        self.stdout = mock_target("sys.stdout", new_callable=StringIO)
        mock_target("clear_repo_url.MAX_ITERATIONS", new=1)
        env = patch.dict(os.environ, _env(), clear=True)
        env.start()
        self.addCleanup(env.stop)

        self.p = self.playwright.return_value.__enter__.return_value
        self.browser = self.p.chromium.launch.return_value
        self.page = self.browser.new_page.return_value
        self.page.query_selector.return_value = None
        self.api = self.p.request.new_context.return_value
        self.api.patch.return_value.ok = True
        self.api.patch.return_value.json.return_value = {"homepage": ""}
        self.urlopen.return_value = _make_response({"homepage": ""})

    def test_url_removal_uses_empty_string_and_verifies_readback(self):
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.api.patch.assert_called_once_with(
            "/repos/owner/repo", data={"homepage": ""}, timeout=15000
        )
        self.assertEqual(self.urlopen.call_count, 2)
        self.api.patch.return_value.json.assert_called_once_with()
        self.assertIn("URL removal verified", self.stdout.getvalue())
        self.api.dispose.assert_called_once_with()
        self.browser.close.assert_called_once_with()

    def test_null_readback_also_confirms_removal(self):
        self.api.patch.return_value.json.return_value = {"homepage": None}
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": None}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.assertIn("URL removal verified", self.stdout.getvalue())

    def test_unchanged_update_response_fails(self):
        self.urlopen.return_value = _make_response({"homepage": "https://example.com"})
        self.api.patch.return_value.json.return_value = {"homepage": "https://example.com"}
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertEqual(self.urlopen.call_count, 1)
        self.assertIn("GitHub accepted the update but the homepage is still set", self.stdout.getvalue())
        self.assertNotIn("URL removal verified", self.stdout.getvalue())

    def test_restored_url_on_readback_fails(self):
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": "https://restored.example.com"}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertIn("Repository homepage is still set after the update", self.stdout.getvalue())
        self.assertNotIn("URL removal verified", self.stdout.getvalue())

    def test_update_response_missing_homepage_does_not_confirm_removal(self):
        self.urlopen.return_value = _make_response({"homepage": "https://example.com"})
        self.api.patch.return_value.json.return_value = {}
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertNotIn("URL removal verified", self.stdout.getvalue())

    def test_readback_missing_homepage_does_not_confirm_removal(self):
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertNotIn("URL removal verified", self.stdout.getvalue())

    def test_readback_network_failure_does_not_confirm_removal(self):
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            urllib.error.URLError("Temporary network error"),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertNotIn("URL removal verified", self.stdout.getvalue())

    def test_anonymous_url_is_cleared_even_when_api_homepage_is_empty(self):
        self.page.query_selector.return_value = MagicMock()
        self.page.query_selector.return_value.get_attribute.return_value = "https://example.com"
        self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.api.patch.assert_called_once()
        self.assertIn("URL removal verified", self.stdout.getvalue())

    def test_missing_token_fails_before_starting_browser(self):
        os.environ.pop("GH_TOKEN")
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.playwright.assert_not_called()
        self.assertIn("PAT_TOKEN", self.stdout.getvalue())

    def test_cli_missing_token_exits_nonzero(self):
        env = _env()
        env.pop("GH_TOKEN")
        result = subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(__file__), "..", "scripts", "clear_repo_url.py")],
            env=env, capture_output=True, text=True, check=False, timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("PAT_TOKEN", result.stdout)

    def test_authentication_and_permission_failures_fail_without_retry(self):
        self.urlopen.return_value = _make_response({"homepage": "https://example.com"})
        self.api.patch.return_value.ok = False
        for status in (401, 403, 404, 422):
            with self.subTest(status=status):
                self.clock.side_effect = MockClock([0, 0])
                self.api.patch.return_value.status = status
                self.assertEqual(clear_repo_url.clear_homepage(), 1)
                self.assertIn(f"GitHub API error {status}", self.stdout.getvalue())
                self.assertIn("Administration: write", self.stdout.getvalue())
        self.sleep.assert_not_called()

    def test_authenticated_read_permission_failure_fails(self):
        self.urlopen.side_effect = urllib.error.HTTPError("https://api.github.com/repos/owner/repo", 403, "Forbidden", None, None)
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.api.patch.assert_not_called()
        self.sleep.assert_not_called()

    def test_ten_consecutive_failures_fail_workflow(self):
        self.clock.side_effect = None
        self.clock.return_value = 0
        self.urlopen.return_value = _make_response({"homepage": "https://example.com"})
        self.api.patch.return_value.ok = False
        self.api.patch.return_value.status = 503
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertEqual(self.api.patch.call_count, 10)
        self.assertIn("Too many consecutive failures (10)", self.stdout.getvalue())

    def test_transient_failure_can_recover(self):
        self.clock.side_effect = MockClock([0, 0, 10, 121])
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
        ]
        failed_response = MagicMock(ok=False, status=503)
        self.api.patch.side_effect = [failed_response, self.api.patch.return_value]
        with patch("clear_repo_url.MAX_ITERATIONS", 2):
            self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.assertEqual(self.api.patch.call_count, 2)
        self.assertIn("URL removal verified", self.stdout.getvalue())

    def test_min_duration_waits(self):
        self.clock.side_effect = MockClock([0, 0, 10, 121])
        with patch("clear_repo_url.MAX_ITERATIONS", 2):
            self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.assertEqual(self.sleep.call_count, 2)
        self.api.patch.assert_not_called()
        self.assertIn("Reached maximum iterations (2) and minimum duration", self.stdout.getvalue())

    def test_workflow_handoff_clears_url_before_exiting(self):
        self.clock.side_effect = MockClock([0, 121])
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
            _make_response({"workflow_runs": [{"id": 101, "name": "Clear Repo URL"}]}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.api.patch.assert_called_once()
        self.sleep.assert_not_called()
        output = self.stdout.getvalue()
        self.assertLess(output.index("URL removal verified"), output.index("Another instance"))

    def test_browser_startup_failure_fails_workflow(self):
        self.p.chromium.launch.side_effect = RuntimeError("Browser unavailable")
        self.assertEqual(clear_repo_url.clear_homepage(), 1)
        self.assertIn("Global Playwright Error", self.stdout.getvalue())

    def test_browser_navigation_failure_closes_page_and_still_clears_via_api(self):
        self.page.goto.side_effect = RuntimeError("Navigation timeout")
        self.urlopen.side_effect = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
        ]
        self.assertEqual(clear_repo_url.clear_homepage(), 0)
        self.page.close.assert_called_once_with()
        self.api.patch.assert_called_once()


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed in the Python environment")
class TestWorkflowDetection(unittest.TestCase):
    @patch("clear_repo_url.urllib.request.urlopen")
    def test_only_newer_runs_of_same_workflow_trigger_handoff(self, urlopen):
        urlopen.side_effect = [
            _make_response({"workflow_runs": [
                {"id": 99, "name": "Clear Repo URL"},
                {"id": 100, "name": "Clear Repo URL"},
                {"id": 101, "name": "Fetch Schedules"},
            ]}),
            _make_response({"workflow_runs": []}),
            _make_response({"workflow_runs": []}),
        ]
        self.assertFalse(clear_repo_url.is_another_workflow_waiting("owner/repo", "test-token", "100", "Clear Repo URL"))

    @patch("clear_repo_url.urllib.request.urlopen")
    def test_newer_run_on_second_page_is_detected(self, urlopen):
        urlopen.side_effect = [
            _make_response({"workflow_runs": [{"id": 99, "name": "Clear Repo URL"}] * 100}),
            _make_response({"workflow_runs": [{"id": 101, "name": "Clear Repo URL"}]}),
        ]
        self.assertTrue(clear_repo_url.is_another_workflow_waiting("owner/repo", "test-token", "100", "Clear Repo URL"))
        self.assertIn("page=2", urlopen.call_args.args[0].full_url)


if __name__ == "__main__":
    unittest.main()
