// tmux on the box, for the Claude Terminal command: find the panes running Claude Code, capture one
// (text + colours) for term-render.ts, and type into it. The TUI is the real one, so its composer,
// @ menu, slash commands, approvals and drafts all live on the box; this side only reads the screen
// and sends keys, over the multiplexed `spark-ctl` ssh (~40ms a call).

import { spawn } from "node:child_process";
import path from "node:path";
import { prefs, q, runWithInput } from "./spark";

/** A non-login bash on the box, script on stdin (the remote login shell is fish; see spark.ts). */
function box(script: string, timeout = 10000): Promise<string> {
  return runWithInput("/usr/bin/ssh", [prefs.sshHost, "bash -s"], script + "\n", timeout);
}

export type PaneState = "waiting" | "working" | "idle";

export interface Pane {
  id: string; // tmux pane id (%12): stable across renames and window moves
  session: string;
  window: string;
  cwd: string;
  width: number;
  height: number;
  state: PaneState;
  /** Plain text of the bottom of the screen: what a permission prompt asks, for lists and the menu bar. */
  tail: string;
}

// What the TUI prints in each state. Approximate by nature: the screen is the only interface.
const WAITING = /Do you want to|Would you like to|❯ 1\. Yes|Esc to cancel/;
const WORKING = /esc to interrupt|ctrl\+c to interrupt/i;

export function paneState(text: string): PaneState {
  if (WAITING.test(text)) return "waiting";
  if (WORKING.test(text)) return "working";
  return "idle";
}

const SEP = "\u001e"; // record separator: never in a capture

/** Every pane on the box whose foreground command is Claude Code, with its state. One ssh call. */
export async function listPanes(): Promise<Pane[]> {
  const out = await box(`
tmux list-panes -a -F '#{pane_id}|#{session_name}|#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_width}|#{pane_height}' 2>/dev/null |
while IFS='|' read -r id s w cmd cwd pw ph; do
  [ "$cmd" = claude ] || continue
  printf 'P|%s|%s|%s|%s|%s|%s\\n' "$id" "$s" "$w" "$cwd" "$pw" "$ph"
  tmux capture-pane -p -t "$id" | sed '/^[[:space:]]*$/d' | tail -n 14
  printf '${SEP}\\n'
done`);
  const panes: Pane[] = [];
  for (const block of out.split(SEP + "\n")) {
    const [head, ...rest] = block.split("\n");
    if (!head?.startsWith("P|")) continue;
    const [, id, session, window, cwd, w, h] = head.split("|");
    const tail = rest.join("\n");
    panes.push({ id, session, window, cwd, width: Number(w), height: Number(h), state: paneState(tail), tail });
  }
  return panes;
}

export interface Snapshot {
  lines: string[];
  cols: number;
  cursor?: { x: number; y: number };
  state: PaneState;
  scrolled: number;
}

const plain = (l: string) => l.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

/**
 * The pane's screen, `scroll` lines back from the live view. Only a window of rows is kept --
 * ending at the last non-empty row, about half as tall as the pane is wide -- because the detail
 * pane scales the image to its width: a 94-row pane drawn whole would be unreadably small.
 */
export async function snapshot(id: string, scroll = 0): Promise<Snapshot> {
  const t = q(id);
  const range = scroll > 0 ? `-S -${scroll} -E $(( $(tmux display -p -t ${t} '#{pane_height}') - 1 - ${scroll} ))` : "";
  const out = await box(`tmux display -p -t ${t} '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}' && tmux capture-pane -p -e -t ${t} ${range}`);
  const nl = out.indexOf("\n");
  const [cols, , cx, cy] = out.slice(0, nl).split(" ").map(Number);
  const lines = out.slice(nl + 1).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let last = lines.length - 1;
  while (last > 0 && !plain(lines[last]).trim()) last--;
  if (scroll === 0) last = Math.max(last, Math.min(cy, lines.length - 1));
  const rows = Math.max(24, Math.round(cols / 2));
  const start = Math.max(0, last + 1 - rows);
  const shown = lines.slice(start, last + 1);
  return {
    lines: shown,
    cols,
    cursor: scroll === 0 ? { x: cx, y: cy - start } : undefined,
    state: paneState(shown.slice(-16).map(plain).join("\n")),
    scrolled: scroll,
  };
}

/**
 * Bring the TUI's composer from `from` to `to` in one call: backspace over what changed, type the
 * rest literally. The search bar mirrors into the composer this way on every keystroke.
 */
export async function retype(id: string, backspaces: number, text: string): Promise<void> {
  const cmds: string[] = [];
  for (let n = backspaces; n > 0; n -= 200) cmds.push(`tmux send-keys -t ${q(id)} ${Array(Math.min(n, 200)).fill("BSpace").join(" ")}`);
  if (text) cmds.push(`tmux send-keys -t ${q(id)} -l -- ${q(text)}`);
  if (cmds.length) await box(cmds.join(" && "));
}

/** tmux key names: Enter, Escape, Up, Down, Tab, BTab, BSpace, C-c, C-u, or a literal digit. */
export async function keys(id: string, ...names: string[]): Promise<void> {
  await box(`tmux send-keys -t ${q(id)} ${names.map(q).join(" ")}`);
}

/** Paste as the terminal would (bracketed): the TUI turns a pasted image path into an attachment. */
export async function paste(id: string, text: string): Promise<void> {
  await box(`tmux set-buffer -b spark-rc -- ${q(text)} && tmux paste-buffer -p -d -b spark-rc -t ${q(id)}`);
}

/** A newline in the composer without sending: the TUI reads backslash-Enter as one. */
export async function newline(id: string): Promise<void> {
  await box(`tmux send-keys -t ${q(id)} -l -- '\\' && tmux send-keys -t ${q(id)} Enter`);
}

/** A detached tmux session running Claude in `dir`, sized for the detail pane. Returns its pane id. */
export async function newSession(dir: string): Promise<string> {
  const base = "rc-" + (path.basename(dir.replace(/\/+$/, "")) || "home").replace(/[^A-Za-z0-9_-]/g, "-");
  const claude = ["claude", "--permission-mode", prefs.chatPermissionMode || "auto", ...(prefs.chatModel ? ["--model", prefs.chatModel] : [])].map(q).join(" ");
  const out = await box(`
d=${dir.startsWith("~") ? `"$HOME"${q(dir.slice(1))}` : q(dir)}
n=${q(base)}; i=2; while tmux has-session -t "=$n" 2>/dev/null; do n=${q(base)}-$i; i=$((i+1)); done
tmux new-session -d -s "$n" -x 96 -y 48 -c "$d" -P -F '#{pane_id}'
tmux send-keys -t "$n" ${q(claude)} Enter`);
  return out.trim().split("\n")[0];
}

export async function killSession(session: string): Promise<void> {
  await box(`tmux kill-session -t ${q("=" + session)}`);
}

export interface FileIndex {
  files: string[];
  dirs: string[];
}

/** Candidates for @ completion: the repo's tracked + untracked files (or a shallow walk), and their directories. */
export async function listFiles(cwd: string): Promise<FileIndex> {
  const out = await box(
    `cd ${q(cwd)} 2>/dev/null || exit 0; { git ls-files -co --exclude-standard 2>/dev/null || find . -maxdepth 4 -type f -not -path '*/.*' -not -path '*/node_modules/*' | sed 's|^\\./||'; } | head -n 30000`,
    20000,
  );
  const files = out.split("\n").filter(Boolean);
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf("/");
    while (i > 0) {
      dirs.add(f.slice(0, i + 1));
      i = f.lastIndexOf("/", i - 1);
    }
  }
  return { files, dirs: [...dirs].sort() };
}

/** Upload a local file into ~/clipboard on the box; returns its absolute remote path. */
export function upload(local: Buffer, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const remote = `clipboard/${name}`;
    const p = spawn("/usr/bin/ssh", [prefs.sshHost, `mkdir -p ~/clipboard && cat > ~/${remote} && echo $HOME/${remote}`], { timeout: 60000 });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${code}`))));
    p.stdin.end(local);
  });
}
