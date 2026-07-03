import os
import time
import json
import urllib.request
import urllib.error

def is_another_workflow_waiting(repo, token, current_run_id, current_workflow_name):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Python-urllib"
    }

    # Only exit if another instance of this SAME workflow is already active or waiting.
    # We check queued, waiting, and in_progress to avoid race conditions and double-execution.
    for status in ["queued", "waiting", "in_progress"]:
        url = f"https://api.github.com/repos/{repo}/actions/runs?status={status}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            runs = data.get("workflow_runs", [])
            for run in runs:
                if str(run.get("id")) != str(current_run_id) and run.get("name") == current_workflow_name:
                    return True
    return False

def clear_homepage():
    token = os.environ.get("GH_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    current_run_id = os.environ.get("GITHUB_RUN_ID")
    current_workflow_name = os.environ.get("GITHUB_WORKFLOW")

    if not token or not repo or not current_workflow_name or not current_run_id:
        print("Missing GH_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW, or GITHUB_RUN_ID environment variable")
        return

    url = f"https://api.github.com/repos/{repo}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Python-urllib"
    }

    iteration = 0
    consecutive_failures = 0
    max_iterations = 180 # Approx 30 minutes at 10s intervals
    while True:
        iteration += 1
        if iteration > max_iterations:
            print(f"Iteration {iteration}: Reached maximum iterations ({max_iterations}). Exiting.")
            break

        try:
            # 1. Check if another instance of this workflow is waiting
            if is_another_workflow_waiting(repo, token, current_run_id, current_workflow_name):
                print(f"Iteration {iteration}: Another instance of '{current_workflow_name}' is active. Exiting.")
                break

            # 2. Get current homepage
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode())
                homepage = data.get("homepage")

            if homepage:
                print(f"Iteration {iteration}: URL found. Clearing...")

                # Clear homepage
                patch_data = json.dumps({"homepage": ""}).encode("utf-8")
                patch_headers = headers.copy()
                patch_headers["Content-Type"] = "application/json"
                patch_req = urllib.request.Request(url, data=patch_data, headers=patch_headers, method="PATCH")
                with urllib.request.urlopen(patch_req) as patch_response:
                    if patch_response.getcode() == 200:
                        print(f"Iteration {iteration}: URL was removed. Exiting.")
                        return # Successfully removed, so we end
                    else:
                        print(f"Iteration {iteration}: Failed to remove URL. Status: {patch_response.getcode()}")
                        consecutive_failures += 1
            else:
                consecutive_failures = 0 # Success (even if no URL removed)
                if iteration % 6 == 1: # Log roughly every minute (10s intervals)
                    print(f"Iteration {iteration}: No URL set, waiting...")

        except urllib.error.HTTPError as e:
            if e.code in [401, 403]:
                print(f"Iteration {iteration}: Unrecoverable authentication error {e.code}. Exiting.")
                break
            print(f"Iteration {iteration}: HTTP Error: {e.code}")
            consecutive_failures += 1
        except Exception as e:
            print(f"Iteration {iteration}: Error: {e}")
            consecutive_failures += 1

        if consecutive_failures >= 10:
            print(f"Iteration {iteration}: Too many consecutive failures ({consecutive_failures}). Exiting.")
            break

        time.sleep(10)

if __name__ == "__main__":
    clear_homepage()
