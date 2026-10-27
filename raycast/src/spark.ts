// Shared plumbing. Every command is a tmux operation on the Spark (over a multiplexed ssh, ~40ms)
// plus, usually, bringing the Ghostty tab that holds the mosh session to the front (AppleScript).
// Nothing here is Ghostty-specific beyond that focus step; tmux is what gives the layout names.

import { getPreferenceValues, showHUD, showToast, Toast, closeMainWindow } from "@raycast/api";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** execFile with stdin: the remote script travels on stdin, so no shell on either side parses it. */
function runWithInput(cmd: string, args: string[], input: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { timeout });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
    p.stdin.end(input);
  });
}

export interface Prefs {
  sshHost: string;
  session: string;
  window: string;
  tabMatch: string;
  srcDir: string;
  agentsKey: string;
}

export const prefs = getPreferenceValues<Prefs>();

/** POSIX single-quote a value for bash on the box. */
export function q(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Run a bash script on the Spark. ssh hands its argv to the remote LOGIN shell -- fish there -- whose
 * quoting differs from POSIX, so the script is not put on the command line at all: `bash -ls` reads
 * it from stdin. Login shell for the bootstrap PATH (claude lives in ~/.local/bin).
 */
export async function ssh(script: string): Promise<string> {
  return runWithInput("/usr/bin/ssh", [prefs.sshHost, "bash -ls"], script + "\n", 15000);
}

/** tmux target for a pane in the layout window: 1 = claude, 2 = shell. */
export function pane(n: 1 | 2): string {
  return `${prefs.session}:${prefs.window}.${n}`;
}

export async function tmux(...cmds: string[]): Promise<string> {
  return ssh(cmds.map((c) => `tmux ${c}`).join(" && "));
}

/** Bring the Ghostty tab running the mosh session to the front. Needs `macos-applescript = true`. */
export async function focusGhostty(): Promise<void> {
  const match = prefs.tabMatch.replace(/"/g, '\\"');
  const script = `
tell application "Ghostty"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if (name of t) contains "${match}" then
        select tab t
        activate window w
        focus (focused terminal of t)
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "none"`;
  try {
    await run("/usr/bin/osascript", ["-e", script]);
  } catch {
    // AppleScript off or Ghostty not scriptable yet: at least raise the app.
    await run("/usr/bin/open", ["-a", "Ghostty"]);
  }
}

/** A no-view command: hide Raycast, do the thing, report failures as a toast. */
export async function action(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await closeMainWindow({ clearRootSearch: true });
    await fn();
    await showHUD(label);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: label + " failed", message: String(e) });
  }
}

/** Repos on the Spark: children of the configured source directory. */
export async function listRepos(): Promise<string[]> {
  const out = await ssh(`ls -1d ${prefs.srcDir}/*/ 2>/dev/null`);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/\/$/, "").split("/").pop() as string);
}

export function repoPath(name: string): string {
  return `${prefs.srcDir}/${name}`;
}

/** Open a new window in the layout session, running `command` in `cwd` from a shell that survives it. */
export async function newWindow(name: string, cwd: string, command: string): Promise<void> {
  const target = `${prefs.session}:${name}`;
  await tmux(
    `new-window -t ${q(prefs.session)} -n ${q(name)} -c ${q(cwd)}`,
    `send-keys -t ${q(target)} ${q(command)} Enter`,
  );
}
