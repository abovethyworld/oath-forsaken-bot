#!/usr/bin/env python3
"""
Bulk emoji uploader — run this ON THE VM (clean IP, no Cloudflare blocks).

Usage:
  1. Put PNG images in ./emoji-upload/ named like: myemoji.png
  2. python3 tools/vm-emoji-upload.py

Reads DISCORD_TOKEN from .env in the bot directory.
Uploads each PNG as a server emoji named after the file.
Paces uploads 20s apart to stay under rate limits.
"""

import base64
import json
import os
import sys
import time
import urllib.request

GUILD_ID = "1558390769746845718"
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "emoji-upload")


def load_token():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    with open(env_path) as f:
        for line in f:
            if line.startswith("DISCORD_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("DISCORD_TOKEN not found in .env")


def api(method, path, data=None, token=None):
    req = urllib.request.Request(
        f"https://discord.com/api/v10{path}",
        data=json.dumps(data).encode() if data else None,
        headers={"Authorization": f"Bot {token}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else {}


def main():
    token = load_token()
    if not os.path.isdir(UPLOAD_DIR):
        os.makedirs(UPLOAD_DIR)
        print(f"Created {UPLOAD_DIR} — drop PNGs in there and run again.")
        return

    files = sorted(f for f in os.listdir(UPLOAD_DIR) if f.lower().endswith(".png"))
    if not files:
        print("No PNGs found in emoji-upload/.")
        return

    # check existing emoji to skip duplicates
    existing = api("GET", f"/guilds/{GUILD_ID}/emojis", token=token)
    existing_names = {e["name"] for e in existing}
    print(f"Server has {len(existing)} emoji.")

    for i, fname in enumerate(files):
        name = os.path.splitext(fname)[0].lower().replace(" ", "_")
        if name in existing_names:
            print(f"SKIP {name} — already exists")
            continue
        with open(os.path.join(UPLOAD_DIR, fname), "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        try:
            d = api(
                "POST",
                f"/guilds/{GUILD_ID}/emojis",
                {"name": name, "image": f"data:image/png;base64,{b64}"},
                token=token,
            )
            print(f"OK {d['name']} -> {d['id']}")
        except Exception as e:
            print(f"FAIL {name}: {e}")
        if i < len(files) - 1:
            time.sleep(20)

    print("Done.")


if __name__ == "__main__":
    main()
