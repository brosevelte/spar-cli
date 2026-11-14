// A Claude Code session transcript (~/.claude/projects/<dir>/<session>.jsonl) as conversation turns,
// and those turns as terminal lines (ANSI-styled, wrapped) for term-render.ts. This is the real
// conversation -- what you said, what Claude said, which tools it ran -- rather than whatever the
// TUI happens to have on screen, so it can be drawn at the popover's width and pinned to the end.

export interface Part {
  t: "text" | "tool";
  text?: string;
  name?: string;
  desc?: string;
  error?: boolean;
}

export interface Turn {
  id: string;
  prompt: string;
  images: number;
  parts: Part[];
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

/** Accumulates transcript lines (fed incrementally as the file grows) into turns. */
export class Transcript {
  turns: Turn[] = [];
  private tools = new Map<string, Part>();
  private cur: Turn | undefined;

  feed(jsonl: string): void {
    for (const line of jsonl.split("\n")) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // a partial first line from a tail read
      }
      const kind = o.type;
      if ((kind !== "user" && kind !== "assistant") || o.isSidechain || o.isMeta) continue;
      const c = (o.message as { content?: unknown } | undefined)?.content;
      const blocks: Block[] = Array.isArray(c) ? (c as Block[]) : [{ type: "text", text: typeof c === "string" ? c : "" }];
      if (kind === "user") {
        if (blocks.length && blocks.every((b) => b.type === "tool_result")) {
          for (const b of blocks) if (b.is_error && b.tool_use_id && this.tools.has(b.tool_use_id)) this.tools.get(b.tool_use_id)!.error = true;
          continue;
        }
        const prompt = blocks.find((b) => b.type === "text" && b.text?.trim())?.text ?? "";
        const images = blocks.filter((b) => b.type === "image").length;
        if (!prompt.trim() && !images) continue;
        if (/^<(command-|local-command|system-reminder|task-notification)/.test(prompt.trim())) continue;
        this.cur = { id: String(o.uuid ?? this.turns.length), prompt, images, parts: [] };
        this.turns.push(this.cur);
        continue;
      }
      if (!this.cur) continue;
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) {
          const last = this.cur.parts[this.cur.parts.length - 1];
          if (last?.t === "text") last.text += "\n\n" + b.text;
          else this.cur.parts.push({ t: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const part: Part = { t: "tool", name: b.name ?? "tool", desc: toolDesc(b.input) };
          if (b.id) this.tools.set(b.id, part);
          this.cur.parts.push(part);
        }
      }
    }
    if (this.turns.length > 200) this.turns = this.turns.slice(-200);
  }
}

function toolDesc(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const k of ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0];
  }
  return "";
}

// ---------------------------------------------------------------------------- as terminal lines

const E = "\x1b[";
const RESET = `${E}0m`;
const USER = `${E}38;2;126;231;135m`; // prompt green, like the TUI's ❯
const DIM = `${E}2m`;
const RED = `${E}38;2;255;123;114m`;
const CODE = `${E}38;2;121;192;255m`;
const BOLD = `${E}1m`;
const UNBOLD = `${E}22m`;

/** Inline markdown the TUI also styles: **bold**, `code`, # headings. Applied after wrapping. */
function inline(s: string, base: string): string {
  return s
    .replace(/\u0000([^\u0001]*)\u0001/g, `${CODE}$1${RESET}${base}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${UNBOLD}`)
    .replace(/`([^`]+)`/g, `${CODE}$1${RESET}${base}`)
    .replace(/^(#{1,6}) (.*)$/, `${BOLD}$2${UNBOLD}`);
}

/** Word-wrap one paragraph line to `width` columns (hard-splitting words longer than a line). */
function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/(\s+)/)) {
    if ((cur + word).length <= width) {
      cur += word;
      continue;
    }
    if (cur.trim()) out.push(cur.replace(/\s+$/, ""));
    cur = word.trimStart();
    while (cur.length > width) {
      out.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Text under a gutter: the first line gets `first`, the rest are indented to match. */
function block(text: string, cols: number, first: string, firstColor: string, color: string): string[] {
  const out: string[] = [];
  const width = cols - 2;
  let fence = false;
  let lead = true;
  // Links show as their text, as in the TUI: wrap what will be displayed, not the URL.
  const shown = text.replace(/\[([^\]]+)\]\((?:https?|file):[^)\s]+\)/g, "\u0000$1\u0001");
  for (const raw of shown.split("\n")) {
    if (/^\s*```/.test(raw)) fence = !fence;
    const pieces = fence || /^\s*```/.test(raw) ? [raw.slice(0, width)] : wrap(raw, width);
    for (const p of pieces) {
      const gutter = lead ? `${firstColor}${first}${RESET}` : "  ";
      lead = false;
      const body = fence || /^\s*```/.test(raw) ? `${CODE}${p}${RESET}` : `${color}${inline(p, color)}${RESET}`;
      out.push(gutter + body);
    }
  }
  return out;
}

/** The whole conversation as styled lines, oldest first. */
export function conversationLines(turns: Turn[], cols: number): string[] {
  const lines: string[] = [];
  for (const t of turns) {
    lines.push("");
    lines.push(...block(t.prompt || "(image)", cols, "❯ ", USER, USER));
    if (t.images) lines.push(`  ${DIM}[${t.images} image${t.images > 1 ? "s" : ""}]${RESET}`);
    for (const p of t.parts) {
      if (p.t === "tool") {
        const d = p.desc ? ` — ${p.desc}` : "";
        const line = `⎿ ${p.error ? "✗" : "⚙"} ${p.name}${d}`;
        lines.push(`  ${p.error ? RED : DIM}${line.slice(0, cols - 3)}${RESET}`);
      } else {
        lines.push("");
        lines.push(...block(p.text ?? "", cols, "● ", "", ""));
      }
    }
  }
  return lines;
}
