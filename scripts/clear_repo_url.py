import os
import sys
import time
import json
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright

# Configurable constants (can be overridden in tests)
MAX_ITERATIONS = 180 # Approx 30 minutes at 10s intervals
MIN_DURATION = 120 # 2 minutes

def get_github_headers(token=None):
    """Constructs shared headers for GitHub API requests."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Python-urllib"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers

def is_another_workflow_waiting(repo, token, current_run_id, current_workflow_name):
    headers = get_github_headers(token)

    # Only exit if another instance of this SAME workflow is already active or waiting.
    for status in ["queued", "waiting", "in_progress"]:
        page = 1
        while True:
            url = f"https://api.github.com/repos/{repo}/actions/runs?status={status}&per_page=100&page={page}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode())
                runs = data.get("workflow_runs", [])
                if not runs:
                    break
                for run in runs:
                    if int(run.get("id")) > int(current_run_id) and run.get("name") == current_workflow_name:
                        return True
                if len(runs) < 100:
                    break
                page += 1
    return False

def clear_homepage():
    """Clear and monitor the repository homepage; return a process exit code."""
    token = os.environ.get("GH_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    current_run_id = os.environ.get("GITHUB_RUN_ID")
    current_workflow_name = os.environ.get("GITHUB_WORKFLOW")

    if not token or not repo or not current_workflow_name or not current_run_id:
        print("::error::Missing GH_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW, or GITHUB_RUN_ID environment variable. Check the PAT_TOKEN repository secret.")
        return 1

    url = f"https://api.github.com/repos/{repo}"
    headers = get_github_headers(token)

    iteration = 0
    consecutive_failures = 0
    exit_code = 0
    start_time = time.time()

    try:
        with sync_playwright() as p:
            # Launch browser once
            browser = p.chromium.launch(headless=True)
            # Create persistent API context
            api_context = p.request.new_context(
                base_url="https://api.github.com",
                extra_http_headers=headers
            )

            while True:
                iteration += 1
                elapsed = time.time() - start_time

                if iteration > MAX_ITERATIONS and elapsed >= MIN_DURATION:
                    if consecutive_failures:
                        print(f"::error::Iteration {iteration}: Monitoring ended with an unverified repository homepage.")
                        exit_code = 1
                    else:
                        print(f"Iteration {iteration}: Reached maximum iterations ({MAX_ITERATIONS}) and minimum duration. Exiting.")
                    break

                try:
                    # 1. Get current homepage (Logged in check via API)
                    homepage_auth = None
                    req_auth = urllib.request.Request(url, headers=headers)
                    with urllib.request.urlopen(req_auth, timeout=15) as response:
                        homepage_auth = json.loads(response.read().decode())["homepage"]

                    # 2. Get current homepage (Logged out check via Playwright Browser)
                    homepage_anon = None
                    page = None
                    try:
                        page = browser.new_page()
                        # Check the public repo page
                        repo_url = f"https://github.com/{repo}"
                        page.goto(repo_url, wait_until="domcontentloaded", timeout=30000)
                        # The homepage URL link has data-test-selector="repo-website-url"
                        link = page.query_selector('a[data-test-selector="repo-website-url"]')
                        if link:
                            homepage_anon = link.get_attribute("href")
                    except Exception as e:
                        if iteration % 6 == 1:
                            print(f"Iteration {iteration}: Playwright anon check Error: {e}")
                    finally:
                        if page is not None:
                            page.close()

                    if homepage_auth or homepage_anon:
                        auth_len = len(homepage_auth) if homepage_auth else 0
                        anon_len = len(homepage_anon) if homepage_anon else 0
                        print(f"Iteration {iteration}: URL found (Auth: {auth_len} chars, Anon: {anon_len} chars). Clearing...")

                        # 3. Explicitly clear the string field; null can leave it unchanged.
                        patch_response = api_context.patch(
                            f"/repos/{repo}",
                            data={"homepage": ""},
                            timeout=15000
                        )
                        if not patch_response.ok:
                            raise urllib.error.HTTPError(
                                url, patch_response.status, "Repository homepage update failed", None, None
                            )
                        updated_repo = patch_response.json()
                        if updated_repo["homepage"] not in (None, ""):
                            raise RuntimeError("GitHub accepted the update but the homepage is still set")

                        # A successful HTTP response alone does not confirm removal.
                        with urllib.request.urlopen(req_auth, timeout=15) as response:
                            verified_repo = json.loads(response.read().decode())
                        if verified_repo["homepage"] not in (None, ""):
                            raise RuntimeError("Repository homepage is still set after the update; it may have been restored by another integration")
                        print(f"Iteration {iteration}: URL removal verified. Continuing monitoring...")
                        consecutive_failures = 0
                    else:
                        consecutive_failures = 0
                        if iteration % 6 == 1:
                            print(f"Iteration {iteration}: No URL set, waiting... (Elapsed: {int(elapsed)}s)")

                    # Clear first, even if the newer workflow is only queued.
                    if elapsed >= MIN_DURATION and is_another_workflow_waiting(repo, token, current_run_id, current_workflow_name):
                        print(f"Iteration {iteration}: Another instance of '{current_workflow_name}' is active. Exiting.")
                        break

                except Exception as e:
                    if isinstance(e, urllib.error.HTTPError) and e.code in (401, 403, 404, 422):
                        print(f"::error::Iteration {iteration}: GitHub API error {e.code}. Check PAT_TOKEN validity, repository access, and Administration: write permission (plus Actions: read for monitoring). Exiting.")
                        exit_code = 1
                        break
                    print(f"Iteration {iteration}: Error: {e}")
                    consecutive_failures += 1

                if consecutive_failures >= 10:
                    print(f"::error::Iteration {iteration}: Too many consecutive failures ({consecutive_failures}). Exiting.")
                    exit_code = 1
                    break

                time.sleep(10)

            api_context.dispose()
            browser.close()
            return exit_code
    except Exception as e:
        print(f"::error::Global Playwright Error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(clear_homepage())
