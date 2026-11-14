// A Claude Code session transcript (~/.claude/projects/<dir>/<session>.jsonl) as conversation turns,
// and those turns as markdown for a Raycast detail pane. This is the real conversation -- what you
// said, what Claude said, which tools it ran -- as text, rather than whatever the TUI has on screen.

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

// ---------------------------------------------------------------------------- as markdown

// `$` would start a LaTeX span in Raycast's markdown renderer (red text).
const noMath = (s: string) => s.replace(/\$/g, "\\$");

/**
 * The conversation as markdown, newest exchange first: a Raycast detail pane always opens at the
 * top, so the latest message is visible however long the session is. Claude's replies are markdown
 * already and render as such; tool calls collapse to one line each, as the TUI shows them.
 */
export function conversationMarkdown(turns: Turn[], max = 12): string {
  const out: string[] = [];
  for (const t of turns.slice(-max).reverse()) {
    const prompt = noMath(t.prompt.trim() || "(image)")
      .split("\n")
      .map((l, i) => `> ${i === 0 ? "**❯** " : ""}${l}`)
      .join("\n");
    out.push(prompt + (t.images ? `\n>\n> _${t.images} image${t.images > 1 ? "s" : ""}_` : ""));
    let tools: string[] = [];
    const flush = () => {
      if (tools.length) out.push(tools.join("  \n"));
      tools = [];
    };
    for (const p of t.parts) {
      if (p.t === "tool") tools.push(`\`${p.error ? "✗" : "⎿"} ${p.name}\`${p.desc ? " " + noMath(p.desc) : ""}`);
      else {
        flush();
        out.push(noMath(p.text ?? ""));
      }
    }
    flush();
    out.push("---");
  }
  return out.join("\n\n");
}
