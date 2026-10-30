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

/** A message worth showing: a user/assistant turn with text or a tool call, or a tool result. */
function visible(m: Message): boolean {
  if (m.role === "user") return blocks(m).some((b) => b.type === "text" && b.text?.trim());
  if (m.role === "assistant") return blocks(m).some((b) => (b.type === "text" && b.text?.trim()) || b.type === "tool_call");
  if (m.role === "tool") return blocks(m).some((b) => b.type === "tool_result" || b.type === "patch");
  return false;
}

// `$` would start a LaTeX span in Raycast's renderer (that was the red text); nothing else is escaped,
// because Claude's text IS markdown and should render as such.
const noMath = (s: string) => s.replace(/\$/g, "\\$");

const clip = (s: string, chars: number, lines: number) => {
  let out = s.split("\n").slice(0, lines).join("\n");
  if (out.length > chars) out = out.slice(0, chars);
  return out.length < s.length ? out + "\n…" : out;
};

function fence(body: string, lang = ""): string {
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function bold(text: string, words: string[]): string {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.replace(re, "**$1**");
}

function toolCall(b: Block): string {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(b.input ?? "{}");
  } catch {
    // Not JSON (some harnesses store a plain string): show it as-is below.
    return `**⚙ ${b.name ?? "tool"}**\n\n${fence(clip(b.input ?? "", 1500, 25))}`;
  }
  const desc = typeof input.description === "string" ? ` — ${noMath(input.description)}` : "";
  if (typeof input.command === "string") return `**⚙ ${b.name}**${desc}\n\n${fence(clip(input.command, 1500, 25), "sh")}`;
  const path = input.file_path ?? input.path ?? input.pattern;
  if (typeof path === "string" && Object.keys(input).length <= 3) return `**⚙ ${b.name}** \`${path}\`${desc}`;
  return `**⚙ ${b.name}**${desc}\n\n${fence(clip(JSON.stringify(input, null, 2), 1500, 25), "json")}`;
}

function render(m: Message, words: string[]): string {
  const out: string[] = [];
  for (const b of blocks(m)) {
    if (b.type === "text" && b.text?.trim()) {
      const t = bold(noMath(clip(b.text.trim(), 2500, 60)), words);
      out.push(m.role === "user" ? `**You**\n\n${t.split("\n").map((l) => "> " + l).join("\n")}` : `**Claude**\n\n${t}`);
    } else if (b.type === "tool_call") {
      out.push(toolCall(b));
    } else if (b.type === "tool_result") {
      const err = b.is_error === "True" ? " (error)" : "";
      out.push(`*↳ result${err}*\n\n${fence(clip(b.content ?? "", 1200, 15))}`);
    } else if (b.type === "patch") {
      out.push(`*↳ edited files*`);
    }
  }
  return out.join("\n\n");
}

/** The matched message with one visible message of context either side. */
export function renderAround(msgs: Message[], index: number, words: string[]): string {
  const before: number[] = [];
  for (let i = index - 1; i >= 0 && before.length < 1; i--) if (visible(msgs[i])) before.push(i);
  const after: number[] = [];
  for (let i = index + 1; i < msgs.length && after.length < 1; i++) if (visible(msgs[i])) after.push(i);
  const dim = (i: number) => render(msgs[i], []);
  const parts = [
    ...before.reverse().map(dim),
    msgs[index] ? render(msgs[index], words) : "_message not found_",
    ...after.map(dim),
  ].filter(Boolean);
  return parts.join("\n\n");
}
