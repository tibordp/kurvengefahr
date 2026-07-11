"""One-shot first-boot setup for the dev Garage node, via its v2 admin API (the container image
is scratch-based, so there's no shell to script the CLI with). Idempotent: re-running against an
already-initialized node skips every step, so `docker compose up` is always safe.

Steps: wait for the admin API -> assign the single node a layout role -> create the bucket ->
import the fixed dev key -> grant it read/write. Stdlib only (runs in python:3-alpine).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

ADMIN = os.environ.get("GARAGE_ADMIN", "http://garage:3903")
TOKEN = os.environ["GARAGE_ADMIN_TOKEN"]
BUCKET = os.environ["BUCKET"]
KEY_ID = os.environ["KEY_ID"]
KEY_SECRET = os.environ["KEY_SECRET"]


def call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        f"{ADMIN}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def main() -> None:
    deadline = time.monotonic() + 60
    while True:
        try:
            status = call("GET", "/v2/GetClusterStatus")
            break
        except (urllib.error.URLError, OSError):
            if time.monotonic() > deadline:
                sys.exit("garage admin API did not come up within 60s")
            time.sleep(0.5)

    node = status["nodes"][0]
    if node["role"] is None:
        print(f"assigning layout role to node {node['id'][:16]}…")
        call(
            "POST",
            "/v2/UpdateClusterLayout",
            {"roles": [{"id": node["id"], "zone": "dev", "capacity": 1_000_000_000, "tags": []}]},
        )
        call("POST", "/v2/ApplyClusterLayout", {"version": status["layoutVersion"] + 1})
    else:
        print("layout already assigned")

    try:
        bucket = call("GET", f"/v2/GetBucketInfo?globalAlias={BUCKET}")
        print(f"bucket {BUCKET} already exists")
    except urllib.error.HTTPError:
        bucket = call("POST", "/v2/CreateBucket", {"globalAlias": BUCKET})
        print(f"created bucket {BUCKET}")

    try:
        call("GET", f"/v2/GetKeyInfo?id={KEY_ID}")
        print("dev key already imported")
    except urllib.error.HTTPError:
        call(
            "POST",
            "/v2/ImportKey",
            {"accessKeyId": KEY_ID, "secretAccessKey": KEY_SECRET, "name": "kg-dev"},
        )
        print("imported dev key")

    call(
        "POST",
        "/v2/AllowBucketKey",
        {
            "bucketId": bucket["id"],
            "accessKeyId": KEY_ID,
            "permissions": {"read": True, "write": True, "owner": False},
        },
    )
    print("garage ready")


if __name__ == "__main__":
    main()
