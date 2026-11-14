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
  // Read upward from the composer box and stop at the first row that isn't part of a menu: the
  // rows above a menu are the conversation, and an indented line of Claude's reply must never be
  // taken for a menu entry (Enter would then press Down first, which in an empty-ish composer walks
  // the prompt history and wipes the draft).
  const top = rows.findIndex((r) => RULE.test(r));
  let pendingDetail: string[] = [];
  const found: MenuItem[] = [];
  const marked: boolean[] = [];
  for (let i = (top < 0 ? 0 : top) - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.trim()) {
      if (found.length) break;
      continue;
    }
    const lead = r.length - r.trimStart().length;
    let t = r.trim();
    const isHi = t.startsWith("❯");
    if (isHi) t = t.slice(1).trim();
    if (lead <= 6 && t.startsWith("+ ")) {
      found.push({ kind: "file", label: t.slice(2).trim() });
    } else if (lead <= 6 && /^\/\S/.test(t)) {
      const m = /^(\S+)\s*(.*)$/.exec(t)!;
      const detail = [m[2], ...pendingDetail.reverse()].filter(Boolean).join(" ");
      found.push({ kind: "command", label: m[1], detail: detail || undefined });
    } else if (lead >= 10 && !isHi) {
      // a wrapped description line of the command below it... or a right-aligned hint
      // ("✔ Update installed") when no entry follows; kept only if an entry claims it
      pendingDetail.push(t);
      continue;
    } else break;
    marked.push(isHi);
    pendingDetail = [];
  }
  if (!found.length) return undefined;
  found.reverse();
  marked.reverse();
  items.push(...found);
  hi = marked.indexOf(true);
  return { items, hi };
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
  const tidy = (rs: string[]) => {
    const out = rs.filter((r) => !RULE.test(r)).map((r) => r.replace(/\s+$/, ""));
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  if (p.needs) {
    // A question: all of it, as the TUI draws it.
    return "**Claude is asking**\n\n```\n" + tidy(rows).join("\n") + "\n```";
  }
  // The input box (between its two rules) as a code block, and the status line under it as plain
  // text -- inside the block it wrapped at the pane's width and read as noise.
  const rules = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return "```\n" + (tidy(rows).join("\n") || "❯ ▌") + "\n```";
  const input = tidy(rows.slice(rules[0] + 1, rules[1]));
  const status = tidy(rows.slice(rules[1] + 1))[0]?.trim();
  return "```\n" + (input.join("\n") || "❯ ▌") + "\n```" + (status ? `\n\n${status.replace(/([*_`\\$])/g, "\\$1")}` : "");
}
