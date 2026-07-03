import json
import os
import sys
import unittest
import urllib.error
from io import StringIO
from unittest.mock import MagicMock, call, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from clear_repo_url import clear_homepage


def _make_response(body: dict, status: int = 200):
    """Return a mock context-manager response for urllib.request.urlopen."""
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


class TestClearHomepageMissingEnvVars(unittest.TestCase):
    """clear_homepage() returns early when required env vars are absent."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_env_vars(self, mock_sleep, mock_urlopen):
        # Test missing GITHUB_WORKFLOW
        env = {"GITHUB_REPOSITORY": "owner/repo", "GH_TOKEN": "token", "GITHUB_RUN_ID": "100"}
        with patch.dict(os.environ, env, clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()
        self.assertIn("Missing GH_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW, or GITHUB_RUN_ID", output)

        # Test missing GH_TOKEN
        env = {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_WORKFLOW": "Clear Repo URL", "GITHUB_RUN_ID": "100"}
        with patch.dict(os.environ, env, clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()
        self.assertIn("Missing GH_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW, or GITHUB_RUN_ID", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_github_repository(self, mock_sleep, mock_urlopen):
        env = {"GH_TOKEN": "mytoken", "GITHUB_WORKFLOW": "Clear Repo URL", "GITHUB_RUN_ID": "100"}
        with patch.dict(os.environ, env, clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        mock_urlopen.assert_not_called()
        mock_sleep.assert_not_called()
        self.assertIn("Missing GH_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW, or GITHUB_RUN_ID", output)


class TestClearHomepageExits(unittest.TestCase):
    """clear_homepage() exits when another workflow is waiting or URL is removed."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_another_workflow_queued(self, mock_sleep, mock_urlopen):
        """Should exit immediately if another queued instance of the SAME workflow is found."""
        # Another instance with same name
        queued_resp = _make_response({"workflow_runs": [{"id": "101", "name": "Clear Repo URL"}]})
        mock_urlopen.side_effect = [queued_resp]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Another instance of 'Clear Repo URL' is active. Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_continues_when_different_workflow_queued(self, mock_sleep, mock_urlopen):
        """Should NOT exit if another queued workflow has a different name."""
        different_workflow_resp = _make_response({"workflow_runs": [{"id": "101", "name": "Other Workflow"}]})
        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            # Iteration 1
            different_workflow_resp, # queued check (finds other)
            empty_runs_resp, # waiting check
            empty_runs_resp, # in_progress check
            _make_response({"homepage": ""}), # homepage check
            # Iteration 2
            empty_runs_resp, # queued check
            empty_runs_resp, # waiting check
            empty_runs_resp, # in_progress check
            _make_response({"homepage": "https://example.com"}), # found it
            _make_response({}, status=200) # cleared it
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: No URL set, waiting...", output)
        self.assertIn("Iteration 2: URL found. Clearing...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_url_removed(self, mock_sleep, mock_urlopen):
        """Should exit after successfully clearing the homepage."""
        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": "https://example.com"}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found. Clearing...", output)
        self.assertIn("URL was removed. Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_auth_error_401(self, mock_sleep, mock_urlopen):
        """Should exit immediately on 401 errors."""
        mock_urlopen.side_effect = urllib.error.HTTPError("url", 401, "Unauthorized", {}, None)

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Unrecoverable authentication error 401. Exiting.", output)
        mock_sleep.assert_not_called()

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_auth_error_403(self, mock_sleep, mock_urlopen):
        """Should exit immediately on 403 errors that are NOT rate limits."""
        mock_urlopen.side_effect = urllib.error.HTTPError("url", 403, "Forbidden", {}, None)

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Unrecoverable authentication/permission error 403. Exiting.", output)
        mock_sleep.assert_not_called()

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_retries_on_rate_limit_403(self, mock_sleep, mock_urlopen):
        """Should retry on 403 errors that include Retry-After."""
        empty_runs_resp = _make_response({"workflow_runs": []})
        rate_limit_err = urllib.error.HTTPError("url", 403, "Rate Limit", {"Retry-After": "60"}, None)

        mock_urlopen.side_effect = [
            empty_runs_resp, # iteration 1 queued
            empty_runs_resp, # iteration 1 waiting
            empty_runs_resp, # iteration 1 in_progress
            rate_limit_err,  # iteration 1 homepage check fails with rate limit
            empty_runs_resp, # iteration 2 queued
            empty_runs_resp, # iteration 2 waiting
            empty_runs_resp, # iteration 2 in_progress
            _make_response({"homepage": "https://example.com"}), # iteration 2 success
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: Rate limited (403). Retrying...", output)
        self.assertIn("Iteration 2: URL found. Clearing...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_consecutive_failures(self, mock_sleep, mock_urlopen):
        """Should exit after 10 consecutive failures."""
        empty_runs_resp = _make_response({"workflow_runs": []})
        # Mock responses to fail 10 times in a row
        side_effects = []
        for _ in range(10):
            side_effects.extend([
                empty_runs_resp, # queued
                empty_runs_resp, # waiting
                empty_runs_resp, # in_progress
                Exception("error") # homepage check fails
            ])
        mock_urlopen.side_effect = side_effects

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Too many consecutive failures (10). Exiting.", output)
        self.assertEqual(mock_sleep.call_count, 9)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_max_iterations(self, mock_sleep, mock_urlopen):
        """Should exit after reaching max_iterations."""
        empty_runs_resp = _make_response({"workflow_runs": []})
        # Mock responses to keep it waiting
        mock_urlopen.side_effect = [
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": ""}), # homepage is empty
        ] * 200 # more than max_iterations

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Reached maximum iterations (180). Exiting.", output)


class TestClearHomepagePrivacyAndHeaders(unittest.TestCase):
    """Checks headers and that secret URL is not logged."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_homepage_url_not_printed_to_logs(self, mock_sleep, mock_urlopen):
        secret_url = "https://super-secret-url.example.com"
        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            empty_runs_resp,
            empty_runs_resp,
            empty_runs_resp,
            _make_response({"homepage": secret_url}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertNotIn(secret_url, output)


if __name__ == "__main__":
    unittest.main()
