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


class TestClearHomepageMissingEnvVars(unittest.TestCase):
    """clear_homepage() returns early when required env vars are absent."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_both_env_vars(self, mock_sleep, mock_urlopen):
        with patch.dict(os.environ, {}, clear=True):
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
        queued_resp = _make_response({"workflow_runs": [{"id": "101"}]})
        mock_urlopen.side_effect = [queued_resp]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Another workflow is waiting. Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_when_url_removed(self, mock_sleep, mock_urlopen):
        """Should exit after successfully clearing the homepage."""
        mock_urlopen.side_effect = [
            _make_response({"workflow_runs": []}), # queued
            _make_response({"workflow_runs": []}), # waiting
            _make_response({"homepage": "https://example.com"}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found. Clearing...", output)
        self.assertIn("URL was removed. Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_auth_error(self, mock_sleep, mock_urlopen):
        """Should exit immediately on 401 or 403 errors."""
        mock_urlopen.side_effect = urllib.error.HTTPError("url", 401, "Unauthorized", {}, None)

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Unrecoverable authentication error 401. Exiting.", output)
        mock_sleep.assert_not_called()

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exits_on_consecutive_failures(self, mock_sleep, mock_urlopen):
        """Should exit after 10 consecutive failures."""
        mock_urlopen.side_effect = Exception("error")

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Too many consecutive failures (10). Exiting.", output)
        self.assertEqual(mock_sleep.call_count, 9)


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


if __name__ == "__main__":
    unittest.main()
