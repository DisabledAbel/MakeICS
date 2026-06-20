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
            os.environ.pop("GH_TOKEN", None)
            os.environ.pop("GITHUB_REPOSITORY", None)
            with patch.dict(os.environ, {}):
                env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_REPOSITORY")}
                with patch.dict(os.environ, env, clear=True):
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


class TestClearHomepageHomepagePresent(unittest.TestCase):
    """clear_homepage() clears the URL when homepage is set."""

    def _env(self):
        return {"GH_TOKEN": "tok123", "GITHUB_REPOSITORY": "owner/repo"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_clears_homepage_when_set(self, mock_sleep, mock_urlopen):
        """When homepage is set, a PATCH request is issued and success is logged."""
        get_resp = _make_response({"homepage": "https://example.com"})
        patch_resp = _make_response({}, status=200)
        mock_urlopen.side_effect = [get_resp, patch_resp] + [
            _make_response({"homepage": None}) for _ in range(29)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: URL found. Clearing...", output)
        self.assertIn("Iteration 1: URL was removed.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_patch_request_uses_correct_method_and_body(self, mock_sleep, mock_urlopen):
        """The PATCH request body must be {"homepage": ""} and method must be PATCH."""
        responses = [
            _make_response({"homepage": "https://example.com"}),
            _make_response({}, status=200),
        ] + [_make_response({"homepage": None}) for _ in range(29)]

        captured_requests = []

        def capturing_urlopen(req):
            captured_requests.append(req)
            return responses.pop(0)

        mock_urlopen.side_effect = capturing_urlopen

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        patch_req = captured_requests[1]
        self.assertEqual(patch_req.get_method(), "PATCH")
        self.assertEqual(json.loads(patch_req.data.decode("utf-8")), {"homepage": ""})
        self.assertEqual(patch_req.get_header("Content-type"), "application/json")

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_failed_patch_logs_status(self, mock_sleep, mock_urlopen):
        """When PATCH returns non-200, failure and status code are logged."""
        get_resp = _make_response({"homepage": "https://example.com"})
        patch_resp = _make_response({}, status=422)
        mock_urlopen.side_effect = [get_resp, patch_resp] + [
            _make_response({"homepage": None}) for _ in range(29)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Failed to remove URL. Status: 422", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_homepage_url_not_printed_to_logs(self, mock_sleep, mock_urlopen):
        """The actual homepage URL must NOT appear in stdout (privacy requirement)."""
        secret_url = "https://super-secret-url.example.com"
        get_resp = _make_response({"homepage": secret_url})
        patch_resp = _make_response({}, status=200)
        mock_urlopen.side_effect = [get_resp, patch_resp] + [
            _make_response({"homepage": None}) for _ in range(29)
        ]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertNotIn(secret_url, output)


class TestClearHomepageNoHomepage(unittest.TestCase):
    """clear_homepage() logs 'No URL was removed.' when homepage is absent."""

    def _env(self):
        return {"GH_TOKEN": "tok123", "GITHUB_REPOSITORY": "owner/repo"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_no_homepage_set(self, mock_sleep, mock_urlopen):
        mock_urlopen.side_effect = [_make_response({"homepage": None}) for _ in range(30)]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: No URL was removed.", output)
        self.assertIn("Iteration 30: No URL was removed.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_empty_string_homepage_treated_as_absent(self, mock_sleep, mock_urlopen):
        """An empty string homepage is falsy and should not trigger a PATCH."""
        mock_urlopen.side_effect = [_make_response({"homepage": ""}) for _ in range(30)]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        # urlopen is called once per iteration (only GET, no PATCH)
        self.assertEqual(mock_urlopen.call_count, 30)
        self.assertIn("No URL was removed.", output)
        self.assertNotIn("URL found. Clearing...", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_missing_homepage_key_treated_as_absent(self, mock_sleep, mock_urlopen):
        """Response body without 'homepage' key defaults to None (falsy)."""
        mock_urlopen.side_effect = [_make_response({}) for _ in range(30)]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertNotIn("URL found. Clearing...", output)
        self.assertIn("No URL was removed.", output)


class TestClearHomepageIterationCount(unittest.TestCase):
    """clear_homepage() runs exactly 30 iterations."""

    def _env(self):
        return {"GH_TOKEN": "tok123", "GITHUB_REPOSITORY": "owner/repo"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_runs_exactly_30_iterations(self, mock_sleep, mock_urlopen):
        mock_urlopen.side_effect = [_make_response({"homepage": None}) for _ in range(30)]

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertEqual(mock_urlopen.call_count, 30)
        self.assertIn("Iteration 1:", output)
        self.assertIn("Iteration 30:", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_sleep_called_29_times_not_after_last(self, mock_sleep, mock_urlopen):
        """time.sleep(10) is called after each iteration except the last (30th)."""
        mock_urlopen.side_effect = [_make_response({"homepage": None}) for _ in range(30)]

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        self.assertEqual(mock_sleep.call_count, 29)
        mock_sleep.assert_called_with(10)


class TestClearHomepageRequestHeaders(unittest.TestCase):
    """clear_homepage() sends correctly structured Authorization and Accept headers."""

    def _env(self):
        return {"GH_TOKEN": "mytoken", "GITHUB_REPOSITORY": "myorg/myrepo"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_authorization_header(self, mock_sleep, mock_urlopen):
        captured = []

        def capturing(req):
            captured.append(req)
            return _make_response({"homepage": None})

        mock_urlopen.side_effect = capturing

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        get_req = captured[0]
        self.assertEqual(get_req.get_header("Authorization"), "Bearer mytoken")

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_accept_header(self, mock_sleep, mock_urlopen):
        captured = []

        def capturing(req):
            captured.append(req)
            return _make_response({"homepage": None})

        mock_urlopen.side_effect = capturing

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        get_req = captured[0]
        self.assertEqual(get_req.get_header("Accept"), "application/vnd.github.v3+json")

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_user_agent_header(self, mock_sleep, mock_urlopen):
        captured = []

        def capturing(req):
            captured.append(req)
            return _make_response({"homepage": None})

        mock_urlopen.side_effect = capturing

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        get_req = captured[0]
        self.assertEqual(get_req.get_header("User-agent"), "Python-urllib")

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_correct_api_url(self, mock_sleep, mock_urlopen):
        captured = []

        def capturing(req):
            captured.append(req)
            return _make_response({"homepage": None})

        mock_urlopen.side_effect = capturing

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        get_req = captured[0]
        self.assertEqual(get_req.full_url, "https://api.github.com/repos/myorg/myrepo")


class TestClearHomepageExceptionHandling(unittest.TestCase):
    """clear_homepage() catches exceptions, logs them, and continues looping."""

    def _env(self):
        return {"GH_TOKEN": "tok", "GITHUB_REPOSITORY": "o/r"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exception_on_get_is_caught_and_logged(self, mock_sleep, mock_urlopen):
        mock_urlopen.side_effect = Exception("network error")

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()  # must not raise
            output = mock_stdout.getvalue()

        self.assertIn("Error: network error", output)
        # All 30 iterations attempted
        self.assertEqual(mock_urlopen.call_count, 30)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_exception_on_patch_is_caught_and_logged(self, mock_sleep, mock_urlopen):
        """Exception during PATCH is caught; iteration counter and loop continue."""
        get_resp = _make_response({"homepage": "https://example.com"})
        patch_raises = Exception("patch failed")

        call_count = [0]

        def side_effect(req):
            call_count[0] += 1
            if call_count[0] == 1:
                return get_resp
            if call_count[0] == 2:
                raise patch_raises
            return _make_response({"homepage": None})

        mock_urlopen.side_effect = side_effect

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: Error: patch failed", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_loop_continues_after_exception(self, mock_sleep, mock_urlopen):
        """After an exception in iteration N, iteration N+1 still runs."""
        responses = []
        for i in range(30):
            if i == 0:
                responses.append(Exception("transient"))
            else:
                responses.append(_make_response({"homepage": None}))

        mock_urlopen.side_effect = responses

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: Error: transient", output)
        self.assertIn("Iteration 2: No URL was removed.", output)
        self.assertIn("Iteration 30: No URL was removed.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_sleep_still_called_after_exception(self, mock_sleep, mock_urlopen):
        """time.sleep is still called between iterations even when an exception occurs."""
        mock_urlopen.side_effect = Exception("boom")

        with patch.dict(os.environ, self._env(), clear=True):
            clear_homepage()

        # 29 sleeps (not after last iteration)
        self.assertEqual(mock_sleep.call_count, 29)


class TestClearHomepageMixedIterations(unittest.TestCase):
    """Realistic scenario: homepage present on some iterations, absent on others."""

    def _env(self):
        return {"GH_TOKEN": "tok", "GITHUB_REPOSITORY": "o/r"}

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_clears_on_first_iteration_then_absent(self, mock_sleep, mock_urlopen):
        responses = [
            _make_response({"homepage": "https://example.com"}),  # GET iter 1
            _make_response({}, status=200),                         # PATCH iter 1
        ] + [_make_response({"homepage": None}) for _ in range(29)]

        mock_urlopen.side_effect = responses

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        self.assertIn("Iteration 1: URL was removed.", output)
        self.assertIn("Iteration 2: No URL was removed.", output)
        self.assertIn("Iteration 30: No URL was removed.", output)

    @patch("urllib.request.urlopen")
    @patch("time.sleep")
    def test_all_30_iterations_have_homepage(self, mock_sleep, mock_urlopen):
        """Each iteration finds and clears the homepage."""
        responses = []
        for _ in range(30):
            responses.append(_make_response({"homepage": "https://example.com"}))
            responses.append(_make_response({}, status=200))

        mock_urlopen.side_effect = responses

        with patch.dict(os.environ, self._env(), clear=True):
            with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                clear_homepage()
            output = mock_stdout.getvalue()

        for i in range(1, 31):
            self.assertIn(f"Iteration {i}: URL was removed.", output)

        # 30 GETs + 30 PATCHes = 60 calls
        self.assertEqual(mock_urlopen.call_count, 60)


if __name__ == "__main__":
    unittest.main()
