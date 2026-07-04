import json
import os
import sys
import unittest
import urllib.error
import time
from io import StringIO
from unittest.mock import MagicMock, call, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from clear_repo_url import clear_homepage, get_github_headers, is_another_workflow_waiting


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
    """clear_homepage() exits when another workflow is waiting."""

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
    @patch("time.time")
    def test_continues_when_different_workflow_queued(self, mock_time, mock_sleep, mock_urlopen):
        """Should NOT exit if another queued workflow has a different name."""
        # Mock time to exceed duration and iterations quickly
        mock_time.side_effect = [0, 301, 301]

        different_workflow_resp = _make_response({"workflow_runs": [{"id": "101", "name": "Other Workflow"}]})
        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            # Iteration 1
            different_workflow_resp, # queued check (finds other)
            empty_runs_resp, # waiting check
            empty_runs_resp, # in_progress check
            _make_response({"homepage": ""}), # homepage check auth
            _make_response({"homepage": ""}), # homepage check anon
            # Exits after Iteration 1 due to mock_time and MAX_ITERATIONS (mocked below)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                # Set MAX_ITERATIONS to 1 for quick exit
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: No URL set, waiting...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_continues_monitoring_after_clear(self, mock_time, mock_sleep, mock_urlopen):
        """Should NOT exit after successfully clearing the homepage."""
        # time.time() calls:
        # 1. start_time = time.time() -> 0
        # 2. iteration 1: elapsed = time.time() - start_time -> 0 - 0 = 0
        # 3. iteration 2: elapsed = time.time() - start_time -> 10 - 0 = 10
        # 4. iteration 3: elapsed = time.time() - start_time -> 301 - 0 = 301
        mock_time.side_effect = [0, 0, 10, 301, 301]

        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            # Iteration 1
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": "https://example.com"}), # auth check finds it
            _make_response({"homepage": "https://example.com"}), # anon check finds it
            _make_response({}, status=200), # PATCH clear
            # Iteration 2 (iteration is 2, elapsed is 10)
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": ""}), # auth check empty
            _make_response({"homepage": ""}), # anon check empty
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 2):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found (Auth: 19 chars, Anon: 19 chars). Clearing...", output)
        self.assertIn("URL was removed. Continuing monitoring...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_continues_monitoring_after_clear_v2(self, mock_time, mock_sleep, mock_urlopen):
        """Should NOT exit after successfully clearing the homepage and log subsequent checks."""
        # Start at 0, iterations 1-7, then 301 to exit
        # We need 1 call for start_time, and then 1 per iteration (7 total).
        # At start of iteration 8, we want it to exit.
        mock_time.side_effect = [0] + [i*10 for i in range(1, 8)] + [301]

        empty_runs_resp = _make_response({"workflow_runs": []})
        side_effects = []
        # Iteration 1 finds and clears
        side_effects.extend([
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
            _make_response({}, status=200)
        ])
        # Iterations 2-6: nothing found
        for _ in range(5):
            side_effects.extend([
                empty_runs_resp, empty_runs_resp, empty_runs_resp,
                _make_response({"homepage": ""}), _make_response({"homepage": ""})
            ])
        # Iteration 7: nothing found, should log
        side_effects.extend([
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": ""}), _make_response({"homepage": ""})
        ])

        mock_urlopen.side_effect = side_effects

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 7):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found (Auth: 19 chars, Anon: 0 chars). Clearing...", output)
        self.assertIn("URL was removed. Continuing monitoring...", output)
        self.assertIn("Iteration 7: No URL set, waiting...", output)

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
    @patch("time.time")
    def test_retries_on_rate_limit_403(self, mock_time, mock_sleep, mock_urlopen):
        """Should retry on 403 errors that include Retry-After."""
        mock_time.side_effect = [0, 0, 10, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})
        rate_limit_err = urllib.error.HTTPError("url", 403, "Rate Limit", {"Retry-After": "60"}, None)

        mock_urlopen.side_effect = [
            # Iteration 1
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            rate_limit_err,  # auth check fails
            # Iteration 2
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": "https://example.com"}), # auth check success
            _make_response({"homepage": ""}), # anon check success
            _make_response({}, status=200) # patch success
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 2):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: Rate limited (403). Retrying...", output)
        self.assertIn("Iteration 2: URL found", output)

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
                Exception("error") # auth check fails
            ])
        mock_urlopen.side_effect = side_effects

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Too many consecutive failures (10). Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_exits_on_max_iterations_and_duration(self, mock_time, mock_sleep, mock_urlopen):
        """Should exit after reaching MAX_ITERATIONS AND minimum duration."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            empty_runs_resp, # queued
            empty_runs_resp, # waiting
            empty_runs_resp, # in_progress
            _make_response({"homepage": ""}), # auth
            _make_response({"homepage": ""}), # anon
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Reached maximum iterations (1) and minimum duration. Exiting.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_waits_for_min_duration(self, mock_time, mock_sleep, mock_urlopen):
        """Should NOT exit if MAX_ITERATIONS is reached but NOT minimum duration."""
        # start_time = 0
        # iteration 1: elapsed = 0 -> logs "Iteration 1: No URL set"
        # iteration 2: elapsed = 10 -> doesn't exit because 10 < 300
        # iteration 3: elapsed = 301 -> exits
        mock_time.side_effect = [0, 0, 10, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            # Iteration 1
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": ""}), _make_response({"homepage": ""}),
            # Iteration 2
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": ""}), _make_response({"homepage": ""}),
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                # We use 1 iteration max, but it should do at least 2 because of time
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Reached maximum iterations (1) and minimum duration. Exiting.", output)
        self.assertIn("Iteration 1: No URL set, waiting... (Elapsed: 0s)", output)


class TestClearHomepagePrivacyAndHeaders(unittest.TestCase):
    """Checks headers and that secret URL is not logged."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_homepage_url_not_printed_to_logs(self, mock_time, mock_sleep, mock_urlopen):
        mock_time.side_effect = [0, 301, 301]
        secret_url = "https://super-secret-url.example.com"
        empty_runs_resp = _make_response({"workflow_runs": []})
        mock_urlopen.side_effect = [
            empty_runs_resp,
            empty_runs_resp,
            empty_runs_resp,
            _make_response({"homepage": secret_url}),
            _make_response({"homepage": ""}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertNotIn(secret_url, output)
        self.assertIn(f"URL found (Auth: {len(secret_url)} chars", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_patch_payload_and_headers(self, mock_time, mock_sleep, mock_urlopen):
        """Verify the PATCH request sends 'homepage': null and correct headers."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        # Iteration 1 finds and clears
        mock_urlopen.side_effect = [
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
            _make_response({}, status=200)
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("clear_repo_url.MAX_ITERATIONS", 1):
                clear_homepage()

        # Last call should be the PATCH request
        patch_req = mock_urlopen.call_args_list[-1][0][0]
        self.assertEqual(patch_req.get_method(), "PATCH")

        payload = json.loads(patch_req.data.decode("utf-8"))
        self.assertIn("homepage", payload)
        self.assertIsNone(payload["homepage"])

        self.assertEqual(patch_req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(patch_req.get_header("X-github-api-version"), "2022-11-28")

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_anon_check_fails_gracefully(self, mock_time, mock_sleep, mock_urlopen):
        """Should continue if anon check fails with 403."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            # Iteration 1
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": ""}), # auth check
            urllib.error.HTTPError("url", 403, "Forbidden", {}, None), # anon check fails
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Anon check HTTP Error: 403", output)
        self.assertIn("Reached maximum iterations", output)


class TestGetGithubHeaders(unittest.TestCase):
    """Direct unit tests for the shared get_github_headers() helper."""

    def test_headers_with_token_include_authorization(self):
        headers = get_github_headers("mytoken")
        self.assertEqual(headers["Authorization"], "Bearer mytoken")
        self.assertEqual(headers["Accept"], "application/vnd.github+json")
        self.assertEqual(headers["X-GitHub-Api-Version"], "2022-11-28")
        self.assertEqual(headers["User-Agent"], "Python-urllib")

    def test_headers_without_token_omit_authorization(self):
        headers = get_github_headers()
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["Accept"], "application/vnd.github+json")
        self.assertEqual(headers["X-GitHub-Api-Version"], "2022-11-28")
        self.assertEqual(headers["User-Agent"], "Python-urllib")

    def test_headers_with_explicit_none_token_omit_authorization(self):
        headers = get_github_headers(None)
        self.assertNotIn("Authorization", headers)

    def test_headers_with_falsy_empty_string_token_omit_authorization(self):
        """An empty-string token is falsy and must not produce an Authorization header."""
        headers = get_github_headers("")
        self.assertNotIn("Authorization", headers)

    def test_headers_are_independent_dicts_across_calls(self):
        """Each call must return a fresh dict; mutating one must not leak into another."""
        auth_headers = get_github_headers("tok")
        anon_headers = get_github_headers()

        auth_headers["Content-Type"] = "application/json"

        self.assertNotIn("Content-Type", anon_headers)
        self.assertNotIn("Authorization", anon_headers)
        self.assertIn("Authorization", auth_headers)


class TestIsAnotherWorkflowWaitingHeaders(unittest.TestCase):
    """Verifies is_another_workflow_waiting() builds requests via get_github_headers()."""

    def test_sends_updated_accept_and_api_version_headers_with_token(self):
        empty_resp = _make_response({"workflow_runs": []})
        with patch("urllib.request.urlopen", return_value=empty_resp) as mock_urlopen:
            result = is_another_workflow_waiting("owner/repo", "sometoken", "1", "My Workflow")

        self.assertFalse(result)
        self.assertTrue(mock_urlopen.called)
        req = mock_urlopen.call_args_list[0][0][0]
        self.assertEqual(req.get_header("Authorization"), "Bearer sometoken")
        self.assertEqual(req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(req.get_header("X-github-api-version"), "2022-11-28")
        self.assertEqual(req.get_header("User-agent"), "Python-urllib")


class TestClearHomepageAdditionalEdgeCases(unittest.TestCase):
    """Additional edge cases for the logging/payload changes introduced in this PR."""

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_url_found_only_via_anon_check_logs_zero_auth_chars(self, mock_time, mock_sleep, mock_urlopen):
        """When the auth check returns no homepage but the anon check does, Auth should log 0 chars."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": None}),  # auth check: no homepage key value
            _make_response({"homepage": "https://example.com"}),  # anon check finds it
            _make_response({}, status=200),  # PATCH clear
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                with patch("clear_repo_url.MAX_ITERATIONS", 1):
                    clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("URL found (Auth: 0 chars, Anon: 19 chars). Clearing...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_patch_payload_does_not_send_empty_string(self, mock_time, mock_sleep, mock_urlopen):
        """Regression: the PATCH payload must use null, not an empty string, to clear homepage."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": "https://example.com"}),
            _make_response({"homepage": ""}),
            _make_response({}, status=200),
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("clear_repo_url.MAX_ITERATIONS", 1):
                clear_homepage()

        patch_req = mock_urlopen.call_args_list[-1][0][0]
        raw_body = patch_req.data.decode("utf-8")
        self.assertNotIn('""', raw_body)
        self.assertIn("null", raw_body)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    @patch("time.time")
    def test_auth_request_has_authorization_anon_request_does_not(self, mock_time, mock_sleep, mock_urlopen):
        """The authenticated GET must carry a Bearer token; the anonymous GET must not."""
        mock_time.side_effect = [0, 301, 301]
        empty_runs_resp = _make_response({"workflow_runs": []})

        mock_urlopen.side_effect = [
            empty_runs_resp, empty_runs_resp, empty_runs_resp,
            _make_response({"homepage": ""}),  # auth check
            _make_response({"homepage": ""}),  # anon check
        ]

        with patch.dict(os.environ, _env(), clear=True):
            with patch("clear_repo_url.MAX_ITERATIONS", 1):
                clear_homepage()

        # Calls: 3 workflow-status checks, then auth GET, then anon GET.
        auth_req = mock_urlopen.call_args_list[3][0][0]
        anon_req = mock_urlopen.call_args_list[4][0][0]

        self.assertEqual(auth_req.get_header("Authorization"), "Bearer tok123")
        self.assertIsNone(anon_req.get_header("Authorization"))

        self.assertEqual(auth_req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(anon_req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(auth_req.get_header("X-github-api-version"), "2022-11-28")
        self.assertEqual(anon_req.get_header("X-github-api-version"), "2022-11-28")


if __name__ == "__main__":
    unittest.main()
