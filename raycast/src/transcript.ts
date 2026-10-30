// Render a slice of a captured thread as readable markdown: user turns as quoted "bubbles", Claude's
// text as markdown, tool calls as labelled code blocks, results truncated. Raycast markdown has no
// HTML/CSS, so these are the closest structures it renders.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prefs } from "./spark";

const run = promisify(execFile);

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  content?: string;
  is_error?: string;
  files?: string;
}

interface Message {
  role: string;
  content: Block[] | string;
}

const cache = new Map<string, Message[]>();

export async function loadMessages(atuinId: string): Promise<Message[]> {
  const hit = cache.get(atuinId);
  if (hit) return hit;
  const { stdout } = await run(prefs.atuinPath, ["threads", "show", atuinId, "--style", "json"], {
    timeout: 15000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ATUIN_SESSION: process.env.ATUIN_SESSION ?? "raycast" },
  });
  const msgs = (JSON.parse(stdout) as { messages: Message[] }).messages;
  cache.set(atuinId, msgs);
  return msgs;
}

const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? m.content : []);

const textOf = (m: Message): string =>
  blocks(m)
    .filter((b) => b.type === "text" && b.text?.trim())
    .map((b) => b.text!.trim())
    .join("\n\n");

/** A conversation turn: your message or Claude's reply text. Tool calls, results and reasoning are not. */
const isTurn = (m: Message) => (m.role === "user" || m.role === "assistant") && textOf(m).length > 0;

// `$` would start a LaTeX span in Raycast's renderer (that was the red text); nothing else is escaped,
// because Claude's text IS markdown and should render as such.
const noMath = (s: string) => s.replace(/\$/g, "\\$");

function bold(text: string, words: string[]): string {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.replace(re, "**$1**");
}

/** One line per tool call -- what it was for, not the payload, so a turn never fills the window. */
function toolLine(b: Block): string {
  let desc = "";
  try {
    const input = JSON.parse(b.input ?? "{}") as Record<string, unknown>;
    const d = input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.url;
    if (typeof d === "string") desc = ` — ${noMath(d.length > 100 ? d.slice(0, 100) + "…" : d)}`;
  } catch {
    // Non-JSON input: the tool name alone is the collapsed form.
  }
  return `\`⚙ ${b.name ?? "tool"}\`${desc}`;
}

/** Around a match a turn can be long: keep a window centred on the first word hit. */
function windowed(text: string, words: string[], chars = 1800): string {
  if (text.length <= chars || !words.length) return text;
  const hits = words.map((w) => text.toLowerCase().indexOf(w.toLowerCase())).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, at - chars / 3);
  return (start > 0 ? "…" : "") + text.slice(start, start + chars) + (start + chars < text.length ? "…" : "");
}

function render(m: Message, words: string[]): string {
  const text = textOf(m);
  const out: string[] = [];
  if (text) {
    const t = bold(noMath(windowed(text, words)), words);
    out.push(m.role === "user" ? `**You**\n\n${t.split("\n").map((l) => "> " + l).join("\n")}` : `**Claude**\n\n${t}`);
  }
  const tools = blocks(m).filter((b) => b.type === "tool_call");
  if (tools.length) out.push(tools.map(toolLine).join("  \n"));
  return out.join("\n\n");
}

/**
 * The matched message with one conversation turn of context either side (tool traffic skipped). A match
 * that sits in a tool call shows collapsed: the call's one line plus atuin's short highlighted extract
 * (`matchMd`), never the full command and output.
 */
export function renderAround(msgs: Message[], index: number, words: string[], matchMd: string): string {
  let prev = -1;
  for (let i = index - 1; i >= 0; i--) if (isTurn(msgs[i])) { prev = i; break; }
  let next = -1;
  for (let i = index + 1; i < msgs.length; i++) if (isTurn(msgs[i])) { next = i; break; }
  const m = msgs[index];
  let hit: string;
  if (!m) hit = "_message not found_";
  else if (isTurn(m)) hit = render(m, words);
  else {
    const head = render(m, []) || (m.role === "tool" ? "`↳ tool result`" : `\`${m.role}\``);
    let extract = matchMd.length > 400 ? matchMd.slice(0, 400) + "…" : matchMd;
    if ((extract.match(/\*\*/g) ?? []).length % 2) extract += "**"; // don't leave a cut-off bold open
    hit = `${head}\n\n> ${extract}`;
  }
  return [prev >= 0 ? render(msgs[prev], []) : "", hit, next >= 0 ? render(msgs[next], []) : ""].filter(Boolean).join("\n\n");
}
