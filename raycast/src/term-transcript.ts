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
          // Each reply stays its own part: the TUI gives every one its own ●.
          this.cur.parts.push({ t: "text", text: b.text });
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

// ---- tool calls, summarised the way the TUI collapses them ("Ran 2 shell commands, read 1 file")

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function toolGroup(name: string): string {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "shell";
  if (name === "Read" || name === "NotebookRead") return "read";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "edit";
  if (name === "Write") return "write";
  if (name === "Grep" || name === "Glob" || name === "LS") return "search";
  if (name === "Agent" || name === "Task") return "agent";
  if (name === "WebFetch") return "fetch";
  if (name === "WebSearch") return "websearch";
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "todo";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return "mcp:" + mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
  return "tool:" + name;
}

/** One line for a run of tool calls, in the TUI's words; failures counted at the end. */
export function toolSummary(tools: Part[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const g = toolGroup(t.name ?? "tool");
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const phrases: string[] = [];
  const called: string[] = [];
  for (const [g, n] of counts) {
    if (g === "shell") phrases.push(`ran ${plural(n, "shell command", "shell commands")}`);
    else if (g === "read") phrases.push(`read ${plural(n, "file", "files")}`);
    else if (g === "edit") phrases.push(`edited ${plural(n, "file", "files")}`);
    else if (g === "write") phrases.push(`wrote ${plural(n, "file", "files")}`);
    else if (g === "search") phrases.push(`searched ${plural(n, "time", "times")}`);
    else if (g === "agent") phrases.push(`ran ${plural(n, "agent", "agents")}`);
    else if (g === "fetch") phrases.push(`fetched ${plural(n, "page", "pages")}`);
    else if (g === "websearch") phrases.push("searched the web");
    else if (g === "todo") phrases.push("updated tasks");
    else if (g.startsWith("mcp:")) called.push(g.slice(4));
    else called.push(g.slice(5));
  }
  if (called.length) phrases.unshift(`called ${called.join(", ")}`);
  const failed = tools.filter((t) => t.error).length;
  const line = phrases.join(", ") + (failed ? ` (${failed} failed)` : "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Claude's text with the TUI's ● leading its first line (on a line of its own before a list, table or code). */
function withBullet(text: string): string {
  const t = noMath(text.trim());
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|>)/.test(t)) return `●\n\n${t}`;
  return `● ${t}`;
}

/**
 * Your message as a code block: Raycast markdown has no background colours, but a code block is a
 * full-width grey bar in monospace -- the closest thing to the TUI's highlighted ❯ line.
 */
function userLines(prompt: string, images: number): string {
  const text = (prompt.trim() || "(image)").replace(/\n{3,}/g, "\n\n");
  const fence = text.includes("```") ? "~~~~" : "```";
  const body = text
    .split("\n")
    .map((l, i) => (i === 0 ? "❯ " : "  ") + l)
    .join("\n");
  return `${fence}\n${body}\n${fence}` + (images ? `\n\n_${plural(images, "image", "images")}_` : "");
}

/**
 * The conversation as markdown, newest exchange first: a Raycast detail pane always opens at the
 * top, so the latest message is visible however long the session is. Within an exchange it reads
 * like the TUI: your message (bold, ❯), each run of tool calls as one quiet summary line, Claude's
 * replies (●) as the markdown they already are.
 */
export function conversationMarkdown(turns: Turn[], max = 12): string {
  const out: string[] = [];
  for (const t of turns.slice(-max).reverse()) {
    if (out.length) out.push("---");
    out.push(userLines(t.prompt, t.images));
    let tools: Part[] = [];
    const flush = () => {
      if (tools.length) out.push(`_${toolSummary(tools)}_`);
      tools = [];
    };
    for (const p of t.parts) {
      if (p.t === "tool") tools.push(p);
      else {
        flush();
        out.push(withBullet(p.text ?? ""));
      }
    }
    flush();
  }
  return out.join("\n\n");
}
