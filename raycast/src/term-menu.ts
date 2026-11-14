// Claude's composer area (the attached pane's bottom rows, from term-backend.poll) read as data: its
// menu -- @ files, slash commands, the options of a question -- and the composer itself as text.
// Pure, so it can be checked against real captures outside Raycast.

import type { Poll } from "./term-backend";

export const plain = (l: string) =>
  l
    .replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "")
    .replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
const RULE = /^\s*─{8,}/;

export interface MenuItem {
  kind: "file" | "command" | "option" | "other";
  label: string;
  detail?: string;
  digit?: string;
}

export interface Menu {
  items: MenuItem[];
  hi: number; // the entry Claude has highlighted (❯), or -1 (an @ menu highlights nothing until Down)
}

/**
 * Claude's menu from the composer area, if it shows one: the options of a question, or the @ / slash
 * suggestions drawn just above the composer box ("+ path"; "/command   description" with wrapped
 * description lines indented far right). The highlighted entry carries a ❯.
 */
export function parseMenu(p: Poll | undefined): Menu | undefined {
  if (!p) return undefined;
  const rows = p.bottom.map(plain);
  const items: MenuItem[] = [];
  let hi = -1;
  if (p.needs) {
    for (const r of rows) {
      const m = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/.exec(r);
      if (m) {
        if (m[1]) hi = items.length;
        items.push({ kind: "option", label: m[3], digit: m[2] });
        continue;
      }
      // A long option wraps onto an indented line of its own: part of the option above.
      const last = items[items.length - 1];
      if (last && /^\s{4,}\S/.test(r) && !/Esc to cancel/.test(r)) last.label += " " + r.trim();
      else if (last && !r.trim()) continue;
    }
    return items.length ? { items, hi } : undefined;
  }
  const top = rows.findIndex((r) => RULE.test(r));
  for (const r of rows.slice(0, top < 0 ? 0 : top)) {
    const lead = r.length - r.trimStart().length;
    if (!r.trim()) continue;
    if (lead >= 10) {
      // a wrapped description line (or a right-aligned hint, which has no entry to belong to)
      const last = items[items.length - 1];
      if (last) last.detail = `${last.detail ?? ""} ${r.trim()}`.trim();
      continue;
    }
    let t = r.trim();
    if (t.startsWith("❯")) {
      hi = items.length;
      t = t.slice(1).trim();
    }
    if (t.startsWith("+ ")) items.push({ kind: "file", label: t.slice(2).trim() });
    else if (t.startsWith("/")) {
      const m = /^(\S+)\s*(.*)$/.exec(t)!;
      items.push({ kind: "command", label: m[1], detail: m[2] || undefined });
    } else items.push({ kind: "other", label: t });
  }
  return items.length ? { items, hi } : undefined;
}

/** Claude's composer as text: the box and status line, rules dropped, the cursor marked. */
export function composerMarkdown(p: Poll | undefined, attached: boolean): string {
  if (!attached) return "```\nattaching…\n```";
  if (!p) return "```\n❯ ▌\n```";
  const rows = p.bottom.map(plain);
  // (Not during a question: the cursor sits on the ❯ that marks the highlighted option.)
  if (p.cursor && !p.needs && rows[p.cursor.y] !== undefined) {
    const r = [...rows[p.cursor.y]];
    rows[p.cursor.y] = r.slice(0, p.cursor.x).join("").padEnd(p.cursor.x) + "▌" + r.slice(p.cursor.x + 1).join("");
  }
  // The menu above the box is listed on the left; here, from the box down (all of it for a question).
  const top = rows.findIndex((r) => RULE.test(r));
  const from = p.needs || top < 0 ? 0 : top;
  const shown = rows
    .slice(from)
    .filter((r) => !RULE.test(r))
    .map((r) => r.replace(/\s+$/, ""));
  while (shown.length && !shown[0].trim()) shown.shift();
  const head = p.needs ? "**Claude is asking** — pick an option on the left, or Enter for the highlighted one\n\n" : "";
  return head + "```\n" + (shown.join("\n") || "❯ ▌") + "\n```";
}
