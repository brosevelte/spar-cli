#!/usr/bin/env python3
"""Box-side half of the Raycast "Chat with Claude" command.

The Raycast extension uploads this file to ~/.cache/spark-chat/h-<hash>.py (content-addressed, so a
changed extension brings its own copy and nothing has to be installed) and runs it over the
multiplexed `spark-ctl` ssh with ONE JSON request on stdin. The answer is one JSON object on stdout.

Claude itself never runs under Raycast: Raycast unloads a command when its window closes, so every
turn is a detached `claude -p` in its own process session on the box. It writes the session's normal
transcript (~/.claude/projects/<dir>/<sid>.jsonl), which `show` reads back as compact turns. A chat
is therefore an ordinary Claude Code session: `claude --resume <sid>` opens it in the TUI.

  send   {cwd, sid, text, images:[{media_type, data}], mode, model}   start a turn (refused while one runs)
  show   {sid, limit}                                                  turns + running state + last error
  files  {cwd}                                                         candidates for @ completion
  stop   {sid}                                                         interrupt the running turn
"""

import base64
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".cache", "spark-chat")
CLAUDE = os.path.join(HOME, ".local", "bin", "claude")
# A Raycast chat is small, but `show` may be pointed at a long session: read only the tail.
TAIL_BYTES = 16 * 1024 * 1024
# What an @-mention attaches, at most. The TUI inlines a mentioned file the same way.
MENTION_BYTES = 256 * 1024
MARK = "<!-- spark-chat:file "
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def expand(p):
    return os.path.abspath(os.path.expanduser(p or "~"))


def paths(sid):
    return {
        "pid": os.path.join(STATE, f"{sid}.pid"),
        "log": os.path.join(STATE, f"{sid}.log"),
        "turn": os.path.join(STATE, f"{sid}.turn.jsonl"),
    }


def transcript(sid):
    hits = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def running_pid(sid):
    try:
        pid = int(open(paths(sid)["pid"]).read().split()[0])
        os.kill(pid, 0)
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"claude" not in f.read():
                return None
        return pid
    except (OSError, ValueError, IndexError):
        return None


# --------------------------------------------------------------------------- @ mentions

MENTION = re.compile(r"(?<!\S)@(\S+)")


def mention_blocks(text, cwd):
    """Attach what each @path names, as the TUI does: a file's text, a directory's listing, an image."""
    blocks, seen = [], set()
    for m in MENTION.finditer(text):
        raw = m.group(1)
        for cand in (raw, raw.rstrip(".,;:!?)]}'\"")):
            full = os.path.normpath(os.path.join(cwd, os.path.expanduser(cand)))
            if os.path.exists(full):
                break
        else:
            continue
        if full in seen:
            continue
        seen.add(full)
        rel = os.path.relpath(full, cwd) if full.startswith(cwd + os.sep) else full
        if os.path.isdir(full):
            names = sorted(os.listdir(full))[:300]
            listing = "\n".join(n + ("/" if os.path.isdir(os.path.join(full, n)) else "") for n in names)
            blocks.append({"type": "text", "text": f"{MARK}{rel} -->\nDirectory listing of {rel}:\n```\n{listing}\n```"})
            continue
        ext = os.path.splitext(full)[1].lower()
        if ext in IMAGE_TYPES:
            with open(full, "rb") as f:
                data = base64.b64encode(f.read()).decode()
            blocks.append({"type": "text", "text": f"{MARK}{rel} -->\nImage {rel}:"})
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": IMAGE_TYPES[ext], "data": data}})
            continue
        with open(full, "rb") as f:
            raw_bytes = f.read(MENTION_BYTES + 1)
        if b"\0" in raw_bytes[:8192]:
            continue  # binary: leave the mention as text, Claude can still look at the path
        body = raw_bytes[:MENTION_BYTES].decode("utf-8", "replace")
        more = "\n[... truncated]" if len(raw_bytes) > MENTION_BYTES else ""
        blocks.append({"type": "text", "text": f"{MARK}{rel} -->\nContents of {rel}:\n```\n{body}{more}\n```"})
    return blocks


# --------------------------------------------------------------------------- commands


def cmd_send(req):
    sid, cwd = req["sid"], expand(req.get("cwd"))
    if not os.path.isdir(cwd):
        return out({"ok": False, "error": f"no such directory on the box: {cwd}"})
    if running_pid(sid):
        return out({"ok": False, "error": "Claude is still working on the last message"})
    os.makedirs(STATE, exist_ok=True)
    p = paths(sid)
    text = req.get("text", "")
    content = [{"type": "text", "text": text}] if text.strip() else []
    content += mention_blocks(text, cwd)
    for img in req.get("images", []):
        content.append({"type": "image", "source": {"type": "base64", "media_type": img["media_type"], "data": img["data"]}})
    if not content:
        return out({"ok": False, "error": "nothing to send"})
    with open(p["turn"], "w") as f:
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n")
    argv = [CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    argv += ["--permission-mode", req.get("mode") or "acceptEdits"]
    if req.get("model"):
        argv += ["--model", req["model"]]
    # The first turn names the session so the Mac knows its id before Claude has written anything.
    argv += ["--resume", sid] if transcript(sid) else ["--session-id", sid]
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([os.path.join(HOME, ".local", "bin"), os.path.join(HOME, ".local", "node", "bin"), env.get("PATH", "")])
    with open(p["turn"]) as stdin, open(p["log"], "w") as log:
        # Its own process session: the ssh that started it exits now, and nothing reaches it on hangup.
        proc = subprocess.Popen(argv, cwd=cwd, stdin=stdin, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    with open(p["pid"], "w") as f:
        f.write(f"{proc.pid} {int(time.time())}\n")
    out({"ok": True, "pid": proc.pid})


def tool_desc(name, inp):
    if not isinstance(inp, dict):
        return ""
    for k in ("description", "command", "file_path", "path", "pattern", "url", "query", "prompt"):
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = v.strip().splitlines()[0]
            return v[:140] + ("…" if len(v) > 140 else "")
    return ""


def cmd_show(req):
    sid, limit = req["sid"], int(req.get("limit") or 40)
    running = running_pid(sid) is not None
    t = transcript(sid)
    turns, title, tools = [], None, {}
    if t:
        with open(t, "rb") as f:
            size = os.path.getsize(t)
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line
            lines = f.read().decode("utf-8", "replace").splitlines()
        cur = None
        for line in lines:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            kind = o.get("type")
            if kind == "ai-title":
                title = o.get("aiTitle") or title
                continue
            if kind not in ("user", "assistant") or o.get("isSidechain") or o.get("isMeta"):
                continue
            c = (o.get("message") or {}).get("content")
            blocks = c if isinstance(c, list) else [{"type": "text", "text": c or ""}]
            if kind == "user":
                if blocks and all(b.get("type") == "tool_result" for b in blocks):
                    for b in blocks:
                        if b.get("is_error") and b.get("tool_use_id") in tools:
                            tools[b["tool_use_id"]]["error"] = True
                    continue
                texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
                prompt = next((x for x in texts if not x.startswith(MARK)), "")
                files = [x[len(MARK):].split(" -->", 1)[0] for x in texts if x.startswith(MARK)]
                if not prompt.strip() and not files and not any(b.get("type") == "image" for b in blocks):
                    continue
                cur = {
                    "id": o.get("uuid") or str(len(turns)),
                    "ts": o.get("timestamp"),
                    "prompt": prompt,
                    "images": sum(1 for b in blocks if b.get("type") == "image") - sum(1 for f_ in files if os.path.splitext(f_)[1].lower() in IMAGE_TYPES),
                    "files": files,
                    "parts": [],
                }
                turns.append(cur)
                continue
            if cur is None:
                continue
            for b in blocks:
                bt = b.get("type")
                if bt == "text" and b.get("text", "").strip():
                    if cur["parts"] and cur["parts"][-1]["t"] == "text":
                        cur["parts"][-1]["text"] += "\n\n" + b["text"]
                    else:
                        cur["parts"].append({"t": "text", "text": b["text"]})
                elif bt == "tool_use":
                    part = {"t": "tool", "name": b.get("name", "tool"), "desc": tool_desc(b.get("name"), b.get("input"))}
                    tools[b.get("id")] = part
                    cur["parts"].append(part)
    error = None
    if not running:
        error = last_error(sid)
    out({"running": running, "title": title, "turns": turns[-limit:], "error": error, "transcript": t})


def last_error(sid):
    """The last turn's failure, if it failed: the result line's message, or the log tail when there is none."""
    try:
        lines = open(paths(sid)["log"], errors="replace").read().splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("type") == "result":
            if o.get("is_error") or o.get("subtype") not in (None, "success"):
                return str(o.get("result") or o.get("subtype"))[:2000]
            return None
    tail = [x for x in lines if not x.startswith("{")][-15:]
    return "\n".join(tail)[:2000] if tail else None


def cmd_files(req):
    cwd = expand(req.get("cwd"))
    names = []
    try:
        r = subprocess.run(
            ["git", "-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, timeout=10,
        )
        if r.returncode == 0:
            names = [n for n in r.stdout.decode("utf-8", "replace").split("\0") if n]
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not names:
        skip = {".git", "node_modules", ".venv", "__pycache__", ".cache"}
        for root, dirs, fs in os.walk(cwd):
            dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
            if root[len(cwd):].count(os.sep) >= 4:
                dirs[:] = []
            names += [os.path.relpath(os.path.join(root, f_), cwd) for f_ in fs]
            if len(names) > 30000:
                break
    names = sorted(set(names))[:30000]
    dirs = sorted({os.path.dirname(n) for n in names} - {""})
    out({"cwd": cwd, "files": names, "dirs": [d + "/" for d in dirs]})


def cmd_stop(req):
    pid = running_pid(req["sid"])
    if pid:
        try:
            os.killpg(pid, signal.SIGINT)
        except OSError:
            pass
    out({"ok": True, "stopped": bool(pid)})


def main():
    req = json.loads(sys.stdin.read() or "{}")
    handler = {"send": cmd_send, "show": cmd_show, "files": cmd_files, "stop": cmd_stop}.get(req.get("cmd"))
    if not handler:
        return out({"ok": False, "error": f"unknown command {req.get('cmd')!r}"})
    handler(req)


if __name__ == "__main__":
    main()
