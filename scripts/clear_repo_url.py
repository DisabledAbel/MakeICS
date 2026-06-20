import os
import time
import json
import urllib.request

def clear_homepage():
    token = os.environ.get("GH_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")

    if not token or not repo:
        print("Missing GH_TOKEN or GITHUB_REPOSITORY environment variable")
        return

    url = f"https://api.github.com/repos/{repo}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Python-urllib"
    }

    for i in range(1, 31):
        try:
            # Get current homepage
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode())
                homepage = data.get("homepage")

            if homepage:
                # We don't print the URL to logs as requested in the original workflow (it used /dev/null)
                print(f"Iteration {i}: URL found. Clearing...")

                # Clear homepage
                patch_data = json.dumps({"homepage": ""}).encode("utf-8")
                patch_headers = headers.copy()
                patch_headers["Content-Type"] = "application/json"
                patch_req = urllib.request.Request(url, data=patch_data, headers=patch_headers, method="PATCH")
                with urllib.request.urlopen(patch_req) as patch_response:
                    if patch_response.getcode() == 200:
                        print(f"Iteration {i}: URL was removed.")
                    else:
                        print(f"Iteration {i}: Failed to remove URL. Status: {patch_response.getcode()}")
            else:
                print(f"Iteration {i}: No URL was removed.")

        except Exception as e:
            print(f"Iteration {i}: Error: {e}")

        if i < 30:
            time.sleep(10)

if __name__ == "__main__":
    clear_homepage()
