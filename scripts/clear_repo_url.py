import os
import time
import json
import urllib.request

def is_another_workflow_waiting(repo, token, current_run_id):
    url = f"https://api.github.com/repos/{repo}/actions/runs?status=queued"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Python-urllib"
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            runs = data.get("workflow_runs", [])
            # Check if there are any queued runs that are NOT this one
            for run in runs:
                if str(run.get("id")) != str(current_run_id):
                    return True

            # Also check for 'waiting' status which might happen for environments/approvals
            url_waiting = f"https://api.github.com/repos/{repo}/actions/runs?status=waiting"
            req_waiting = urllib.request.Request(url_waiting, headers=headers)
            with urllib.request.urlopen(req_waiting) as response_waiting:
                data_waiting = json.loads(response_waiting.read().decode())
                runs_waiting = data_waiting.get("workflow_runs", [])
                for run in runs_waiting:
                    if str(run.get("id")) != str(current_run_id):
                        return True
    except Exception as e:
        print(f"Error checking for waiting workflows: {e}")
    return False

def clear_homepage():
    token = os.environ.get("GH_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    current_run_id = os.environ.get("GITHUB_RUN_ID")

    if not token or not repo:
        print("Missing GH_TOKEN or GITHUB_REPOSITORY environment variable")
        return

    url = f"https://api.github.com/repos/{repo}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Python-urllib"
    }

    iteration = 0
    while True:
        iteration += 1
        try:
            # 1. Check if another workflow is waiting
            if is_another_workflow_waiting(repo, token, current_run_id):
                print(f"Iteration {iteration}: Another workflow is waiting. Exiting.")
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
            else:
                if iteration % 6 == 1: # Log roughly every minute (10s intervals)
                    print(f"Iteration {iteration}: No URL set, waiting...")

        except Exception as e:
            print(f"Iteration {iteration}: Error: {e}")

        time.sleep(10)

if __name__ == "__main__":
    clear_homepage()
