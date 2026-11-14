// The box side of Claude Terminal, over the multiplexed `spark-ctl` ssh (~40ms a call):
//   - sessions and their real state from `claude agents --json`
//   - a conversation's real messages from its transcript JSONL (incrementally, by byte offset)
//   - typing: each opened conversation gets a pane in Raycast's own tmux session running
//     `claude attach <id>`; keys go there, and its bottom rows (composer, menus, questions) are
//     captured for the render. Attaching is shared -- Ghostty's agents view can show the same
//     session at once, and both see one composer -- so nothing is taken away from anyone.

import { spawn } from "node:child_process";
import { prefs, q, runWithInput } from "./spark";

/** A non-login bash on the box, script on stdin (the remote login shell is fish; see spark.ts). */
function box(script: string, timeout = 10000): Promise<string> {
  return runWithInput("/usr/bin/ssh", [prefs.sshHost, "bash -s"], script + "\n", timeout);
}

const CLAUDE = `"$HOME/.local/bin/claude"`;
const SEP = "\u001e"; // record separator: never in a capture or a transcript

// ---------------------------------------------------------------------------- sessions

export type AgentState = "needs" | "working" | "done";

export interface Agent {
  id: string; // short id: what `claude attach` takes
  sessionId: string;
  name: string;
  cwd: string;
  startedAt: number;
  state: AgentState;
  raw: string; // claude's own state / status words
}

// `claude agents --json` says working/done and busy/idle; anything else (waiting on input or a
// permission) counts as needing you. In a conversation, the attached pane's screen confirms it.
function agentState(state: string, status: string): AgentState {
  const s = `${state} ${status}`.toLowerCase();
  if (/input|wait|block|permission|ask|attention/.test(s)) return "needs";
  if (/working|busy|running/.test(s)) return "working";
  return "done";
}

/** Every Claude session on the box (interactive and background, finished ones too), newest first. */
export async function listAgents(): Promise<Agent[]> {
  const out = await box(`${CLAUDE} agents --json --all </dev/null`, 15000);
  const raw = JSON.parse(out || "[]") as Array<Record<string, unknown>>;
  return raw
    .map((a) => ({
      id: String(a.id),
      sessionId: String(a.sessionId),
      name: String(a.name ?? a.id),
      cwd: String(a.cwd ?? ""),
      startedAt: Number(a.startedAt ?? 0),
      state: agentState(String(a.state ?? ""), String(a.status ?? "")),
      raw: [a.state, a.status].filter(Boolean).join(" · "),
    }))
    .sort((x, y) => y.startedAt - x.startedAt);
}

/** Dispatch a new background session with `task` in `dir`, as the agents view does. Returns its short id. */
export async function startAgent(dir: string, task: string): Promise<string> {
  const flags = ["--permission-mode", prefs.chatPermissionMode || "auto", ...(prefs.chatModel ? ["--model", prefs.chatModel] : [])].map(q).join(" ");
  const d = dir.startsWith("~") ? `"$HOME"${q(dir.slice(1))}` : q(dir);
  const out = await box(`cd ${d} && ${CLAUDE} --bg ${flags} ${q(task)} </dev/null 2>&1`, 30000);
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out);
  if (!m) throw new Error(out.trim().split("\n").slice(-3).join(" ") || "claude --bg printed no id");
  return m[1];
}

export async function stopAgent(id: string): Promise<void> {
  await box(`${CLAUDE} stop ${q(id)} </dev/null`);
}

// ---------------------------------------------------------------------------- the attached pane

const RC = "spark-raycast";
export const COLS = 92;
const ROWS = 34;

/** The pane in Raycast's tmux session attached to session `id`, created (or re-created) if needed. */
export async function ensureAttached(id: string): Promise<string> {
  const win = `a-${id}`;
  const out = await box(`
tmux has-session -t =${RC} 2>/dev/null || tmux new-session -d -s ${RC} -x ${COLS} -y ${ROWS} -n home
p=$(tmux list-panes -s -t =${RC} -F '#{window_name} #{pane_id} #{pane_dead}' | awk '$1=="${win}" && $3=="0" {print $2; exit}')
if [ -z "$p" ]; then
  tmux kill-window -t =${RC}:${win} 2>/dev/null
  p=$(tmux new-window -d -t =${RC}: -n ${win} -P -F '#{pane_id}' "${CLAUDE.replace(/"/g, "")} attach ${id.replace(/[^0-9a-zA-Z-]/g, "")}")
  tmux resize-window -t "$p" -x ${COLS} -y ${ROWS} 2>/dev/null
fi
echo "$p"`);
  return out.trim().split("\n").pop()!;
}

export interface Poll {
  size: number; // transcript bytes: the next call's offset
  chunk: string; // transcript lines added since the offset (its last 3MB on the first call)
  bottom: string[]; // the attached pane's bottom rows, with escapes
  cursor?: { x: number; y: number }; // within `bottom`
  needs: boolean; // the pane is asking something (permission prompt, choice)
}

const NEEDS = /Do you want to|Would you like to|❯ 1\. |Esc to cancel|Enter to select/;
const plainLine = (l: string) => l.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

/**
 * One round trip for the conversation view: what the transcript gained since `offset`, and the
 * bottom of the attached pane -- just the composer box normally, more rows when it shows a menu or
 * asks a question (up to `rows`).
 */
export async function poll(sessionId: string, offset: number, pane: string | undefined, rows: number): Promise<Poll> {
  const t = pane ? q(pane) : "";
  const out = await box(
    `
f=$(ls -t ~/.claude/projects/*/${q(sessionId)}.jsonl 2>/dev/null | head -1)
size=0; [ -n "$f" ] && size=$(stat -c %s "$f")
echo "$size"
${pane ? `tmux display -p -t ${t} '#{cursor_x} #{cursor_y}' 2>/dev/null || echo "0 0"` : `echo "0 0"`}
printf '${SEP}\\n'
${pane ? `tmux capture-pane -p -e -t ${t} 2>/dev/null` : ""}
printf '${SEP}\\n'
if [ -n "$f" ]; then
  if [ ${offset} -eq 0 ]; then tail -c 3000000 "$f"; elif [ "$size" -gt ${offset} ]; then tail -c +$((${offset} + 1)) "$f"; fi
fi`,
    20000,
  );
  const [head, screen = "", chunk = ""] = out.split(SEP + "\n");
  const [sizeLine, geo = "0 0"] = head.split("\n");
  const [cx, cy] = geo.split(" ").map(Number);
  const lines = screen.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let last = lines.length - 1;
  while (last > 0 && !plainLine(lines[last]).trim()) last--;
  last = Math.max(last, Math.min(cy, lines.length - 1));
  const tail = lines.slice(0, last + 1);
  const plainTail = tail.map(plainLine);
  const needs = NEEDS.test(plainTail.slice(-rows).join("\n"));
  // The composer is boxed by the last two rule lines; a menu (@, /) sits just above the box.
  const rules = plainTail.map((l, i) => (/^─{8,}/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const boxTop = rules.length >= 2 ? rules[rules.length - 2] : Math.max(0, tail.length - 4);
  let start = boxTop;
  while (start > 0 && start > tail.length - rows && /^\s{2,}\S/.test(plainTail[start - 1]) && !/^\s*$/.test(plainTail[start - 1])) start--;
  if (needs) start = Math.max(0, tail.length - rows);
  return {
    size: Number(sizeLine) || 0,
    chunk,
    bottom: tail.slice(start),
    cursor: pane && cy >= start ? { x: cx, y: cy - start } : undefined,
    needs,
  };
}

// ---------------------------------------------------------------------------- typing

/**
 * Bring the composer from what we last typed to what the search bar now says: backspace over the
 * changed tail, type the rest literally. The search bar mirrors into the composer this way.
 */
export async function retype(id: string, backspaces: number, text: string): Promise<void> {
  const cmds: string[] = [];
  for (let n = backspaces; n > 0; n -= 200) cmds.push(`tmux send-keys -t ${q(id)} ${Array(Math.min(n, 200)).fill("BSpace").join(" ")}`);
  if (text) cmds.push(`tmux send-keys -t ${q(id)} -l -- ${q(text)}`);
  if (cmds.length) await box(cmds.join(" && "));
}

/** tmux key names: Enter, Escape, Up, Down, Tab, BTab, BSpace, C-u, or a literal digit. */
export async function keys(id: string, ...names: string[]): Promise<void> {
  await box(`tmux send-keys -t ${q(id)} ${names.map(q).join(" ")}`);
}

/** Paste as a terminal would (bracketed): Claude turns a pasted image path into an attachment. */
export async function paste(id: string, text: string): Promise<void> {
  await box(`tmux set-buffer -b spark-rc -- ${q(text)} && tmux paste-buffer -p -d -b spark-rc -t ${q(id)}`);
}

/** A newline in the composer without sending: Claude reads backslash-Enter as one. */
export async function newline(id: string): Promise<void> {
  await box(`tmux send-keys -t ${q(id)} -l -- '\\' && tmux send-keys -t ${q(id)} Enter`);
}

// ---------------------------------------------------------------------------- files and images

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
