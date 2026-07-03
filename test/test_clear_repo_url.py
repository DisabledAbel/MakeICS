import json
import os
import sys
import unittest
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


class TestClearHomepageMissingEnvVars(unittest.TestCase):
    """clear_homepage() returns early when required env vars are absent."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_both_env_vars(self, mock_sleep, mock_urlopen):
        with patch.dict(os.environ, {}, clear=True):
            if "GH_TOKEN" in os.environ: del os.environ["GH_TOKEN"]
            if "GITHUB_REPOSITORY" in os.environ: del os.environ["GITHUB_REPOSITORY"]
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        mock_urlopen.assert_not_called()
        mock_sleep.assert_not_called()
        self.assertIn("Missing GH_TOKEN or GITHUB_REPOSITORY", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_gh_token(self, mock_sleep, mock_urlopen):
        env = {"GITHUB_REPOSITORY": "owner/repo"}
        with patch.dict(os.environ, env, clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        mock_urlopen.assert_not_called()
        mock_sleep.assert_not_called()
        self.assertIn("Missing GH_TOKEN or GITHUB_REPOSITORY", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_github_repository(self, mock_sleep, mock_urlopen):
        env = {"GH_TOKEN": "mytoken"}
        with patch.dict(os.environ, env, clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        mock_urlopen.assert_not_called()
        mock_sleep.assert_not_called()
        self.assertIn("Missing GH_TOKEN or GITHUB_REPOSITORY", output)


class TestClearHomepageExits(unittest.TestCase):
    """clear_homepage() exits when another workflow is waiting or URL is removed."""

    def _env(self):
        return {"GH_TOKEN": "tok123", "GITHUB_REPOSITORY": "owner/repo", "GITHUB_RUN_ID": "100"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_another_workflow_queued(self, mock_sleep, mock_urlopen):
        """Should exit immediately if another queued workflow is found."""
        # is_another_workflow_waiting: status=queued returns a run with different ID
        queued_resp = _make_response({"workflow_runs": [{"id": "101"}]})
        mock_urlopen.side_effect = [queued_resp]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Another workflow is waiting. Exiting.", output)
        # Only one call to urlopen for queued status
        self.assertEqual(mock_urlopen.call_count, 1)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_another_workflow_waiting(self, mock_sleep, mock_urlopen):
        """Should exit if another waiting workflow is found."""
        # 1. status=queued returns only current run
        queued_resp = _make_response({"workflow_runs": [{"id": "100"}]})
        # 2. status=waiting returns another run
        waiting_resp = _make_response({"workflow_runs": [{"id": "102"}]})
        mock_urlopen.side_effect = [queued_resp, waiting_resp]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Another workflow is waiting. Exiting.", output)
        self.assertEqual(mock_urlopen.call_count, 2)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_url_removed(self, mock_sleep, mock_urlopen):
        """Should exit after successfully clearing the homepage."""
        # 1. queued: none
        # 2. waiting: none
        # 3. repo get: has homepage
        # 4. repo patch: success
        mock_urlopen.side_effect = [
            _make_response({"workflow_runs": []}),
            _make_response({"workflow_runs": []}),
            _make_response({"homepage": "https://example.com"}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found. Clearing...", output)
        self.assertIn("URL was removed. Exiting.", output)
        self.assertEqual(mock_urlopen.call_count, 4)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_continues_if_no_url_and_no_waiting_workflows(self, mock_sleep, mock_urlopen):
        """Should loop and call sleep if no URL is set and no other workflow is waiting."""
        # Iteration 1: no waiting, no URL
        # Iteration 2: another workflow waiting -> exit
        mock_urlopen.side_effect = [
            # Iteration 1
            _make_response({"workflow_runs": []}), # queued
            _make_response({"workflow_runs": []}), # waiting
            _make_response({"homepage": None}),    # repo get
            # Iteration 2
            _make_response({"workflow_runs": [{"id": "999"}]}), # queued -> exit
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: No URL set, waiting...", output)
        self.assertIn("Iteration 2: Another workflow is waiting. Exiting.", output)
        self.assertEqual(mock_sleep.call_count, 1)


class TestClearHomepagePrivacyAndHeaders(unittest.TestCase):
    """Checks headers and that secret URL is not logged."""

    def _env(self):
        return {"GH_TOKEN": "tok123", "GITHUB_REPOSITORY": "owner/repo", "GITHUB_RUN_ID": "100"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_homepage_url_not_printed_to_logs(self, mock_sleep, mock_urlopen):
        secret_url = "https://super-secret-url.example.com"
        mock_urlopen.side_effect = [
            _make_response({"workflow_runs": []}),
            _make_response({"workflow_runs": []}),
            _make_response({"homepage": secret_url}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertNotIn(secret_url, output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_request_headers(self, mock_sleep, mock_urlopen):
        mock_urlopen.side_effect = [
            _make_response({"workflow_runs": [{"id": "101"}]}), # Exit early
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), "Bearer tok123")
        self.assertEqual(req.get_header("Accept"), "application/vnd.github.v3+json")


class TestClearHomepageExceptionHandling(unittest.TestCase):
    """clear_homepage() catches exceptions and continues."""

    def _env(self):
        return {"GH_TOKEN": "tok", "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "1"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exception_in_workflow_check_does_not_stop_loop(self, mock_sleep, mock_urlopen):
        # Iteration 1: exception in workflow check
        # Iteration 2: exit via another workflow
        mock_urlopen.side_effect = [
            Exception("api error"),
            _make_response({"homepage": None}),
            _make_response({"workflow_runs": [{"id": "2"}]})
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Error checking for waiting workflows: api error", output)
        self.assertIn("Iteration 2: Another workflow is waiting. Exiting.", output)


if __name__ == "__main__":
    unittest.main()
