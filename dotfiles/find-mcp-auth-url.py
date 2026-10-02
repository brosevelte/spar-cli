#!/usr/bin/env python3
"""Pull an MCP OAuth authorization URL out of Claude Code's captured server logs.

mcp-remote prints its "open this link to authorize" URL on stderr, and Claude Code swallows
stderr into ~/.cache/claude-cli-nodejs/<project>/mcp-logs-<server>/*.jsonl. Headless, that means
the one thing you need is the one thing you never see.

    find-mcp-auth-url.py [server]        # default: linear
"""

import glob
import json
import os
import re
import sys

server = sys.argv[1] if len(sys.argv) > 1 else "linear"
root = os.path.expanduser("~/.cache/claude-cli-nodejs")
pattern = os.path.join(root, "*", f"mcp-logs-{server}", "*.jsonl")

urls: list[str] = []
for path in sorted(glob.glob(pattern), key=os.path.getmtime):
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            for value in obj.values():
                for url in re.findall(r"https?://[^\s\"'\\]+", str(value)):
                    low = url.lower()
                    if ("authorize" in low or "oauth" in low) and url not in urls:
                        urls.append(url)

if urls:
    print("\n".join(urls[-3:]))
else:
    print(f"no authorization URL in the logs for '{server}'", file=sys.stderr)
    sys.exit(1)
