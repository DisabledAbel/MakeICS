import json
import os
import sys
import unittest
import urllib.error
import time
from io import StringIO
from unittest.mock import MagicMock, call, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

class MockClock:
    """A monotonic clock for mocking time.time() and time.sleep()."""
    def __init__(self, times):
        self.times = list(times)
        self.index = 0

    def __call__(self, *args, **kwargs):
        if self.index < len(self.times):
            val = self.times[self.index]
            self.index += 1
            return val
        return self.times[-1]

try:
    import playwright
    import clear_repo_url
    from clear_repo_url import get_github_headers, is_another_workflow_waiting
    PLAYWRIGHT_AVAILABLE = True
except (ImportError, ModuleNotFoundError):
    PLAYWRIGHT_AVAILABLE = False

def _make_response(body: dict, status: int = 200):
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(body).encode("utf-8")
    mock_resp.getcode.return_value = status
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp

def _env():
    return {
        "GH_TOKEN": "tok123",
        "GITHUB_REPOSITORY": "owner/repo",
        "GITHUB_RUN_ID": "100",
        "GITHUB_WORKFLOW": "Clear Repo URL"
    }

@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed in the Python environment")
class TestClearHomepage(unittest.TestCase):
    @patch("clear_repo_url.sync_playwright")
    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_workflow_logic(self, mock_time, mock_sleep, mock_urlopen, mock_playwright):
        # 1. Test exits when newer workflow found after MIN_DURATION
        mock_time.side_effect = MockClock([0, 121, 121, 121, 121])
        queued_resp = _make_response({"workflow_runs": [{"id": "101", "name": "Clear Repo URL"}]})
        mock_urlopen.side_effect = [queued_resp]

        # Mock Playwright browser context
        mock_p = mock_playwright.return_value.__enter__.return_value
        mock_p.chromium.launch.return_value.new_page.return_value.query_selector.return_value = None

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_repo_url.clear_homepage()
            output = mock_stdout.getvalue()
        self.assertIn("Another instance of 'Clear Repo URL' is active. Exiting.", output)

    @patch("clear_repo_url.sync_playwright")
    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_min_duration_waits(self, mock_time, mock_sleep, mock_urlopen, mock_playwright):
        # 2. Test stays alive for at least MIN_DURATION
        # start_time=0, loop1=0, loop2=10, loop3=121(exit)
        mock_time.side_effect = MockClock([0, 0, 10, 121, 121])
        mock_sleep.side_effect = lambda s: None # No-op

        mock_urlopen.return_value = _make_response({"homepage": ""})
        mock_p = mock_playwright.return_value.__enter__.return_value
        mock_p.chromium.launch.return_value.new_page.return_value.query_selector.return_value = None

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                # Limit iterations to prevent infinite loop if logic fails
                with patch("clear_repo_url.MAX_ITERATIONS", 2):
                    clear_repo_url.clear_homepage()
            output = mock_stdout.getvalue()
        self.assertIn("Iteration 1: No URL set", output)
        self.assertIn("Reached maximum iterations (2) and minimum duration.", output)

    @patch("clear_repo_url.sync_playwright")
    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_url_removal(self, mock_time, mock_sleep, mock_urlopen, mock_playwright):
        # 3. Test URL removal when found
        mock_time.side_effect = MockClock([0, 121, 121, 121, 121])

        # Iteration 1: 3 status checks (all empty) + 1 auth check (finds URL)
        empty_runs = _make_response({"workflow_runs": []})
        auth_found = _make_response({"homepage": "https://example.com"})
        mock_urlopen.side_effect = [empty_runs, empty_runs, empty_runs, auth_found]

        mock_p = mock_playwright.return_value.__enter__.return_value
        mock_p.chromium.launch.return_value.new_page.return_value.query_selector.return_value = None
        mock_p.request.new_context.return_value.patch.return_value.ok = True

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_repo_url.clear_homepage()
            output = mock_stdout.getvalue()
        self.assertIn("URL found", output)
        self.assertIn("URL was removed via Playwright", output)

if __name__ == "__main__":
    unittest.main()
