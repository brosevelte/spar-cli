// Claude's composer area (the attached pane's bottom rows, from term-backend.poll) read as data: its
// menu -- @ files, slash commands, the options of a question -- and the composer itself as text.
// Pure, so it can be checked against real captures outside Raycast.

import { type Poll, isRule } from "./term-backend";

export const plain = (l: string) =>
  l
    .replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "")
    .replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
const RULE = { test: isRule };

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

/** What's typed in Claude's composer right now ("" when it's empty, or when there's no composer box). */
export function composerText(p: Poll | undefined): string {
  if (!p) return "";
  const rows = p.bottom.map(plain);
  const rules = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return "";
  return rows
    .slice(rules[0] + 1, rules[1])
    .map((r) => r.replace(/^\s*❯\s?/, "").trim())
    .join("\n")
    .trim();
}

/** Claude's composer as text: the box and status line, rules dropped, the cursor marked. */
export function composerMarkdown(p: Poll | undefined, attached: boolean): string {
  if (!attached) return "```\nattaching…\n```";
  if (!p) return "```\n❯ ▌\n```";
  const rows = p.bottom.map(plain);
  const boxRules = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
  // The cursor is marked only on the input line: in a question or the subagent list the terminal
  // cursor sits on a list row, where a ▌ reads as a stray glyph.
  const inInput = (y: number) => boxRules.length >= 2 && y > boxRules[0] && y < boxRules[1];
  if (p.cursor && !p.needs && rows[p.cursor.y] !== undefined && inInput(p.cursor.y)) {
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
  // Under the box -- the status line and the subagent list -- only while you're selecting in it
  // (after ↓); otherwise the composer is one slim pill per line (inline code), so the conversation
  // starts right under it instead of below a tall block. The subagent count and the mode are in
  // the title.
  if (!isInteractive(p)) {
    const pill = (l: string) => (l.includes("`") ? "`` " + l + " ``" : "`" + l + "`");
    return (input.length ? input : ["❯ ▌"]).map(pill).join("  \n");
  }
  const box = "```\n" + (input.join("\n") || "❯ ▌") + "\n```";
  // A wide pane right-aligns the subagent timers ~150 columns out; squeeze long runs of spaces so the
  // rows don't wrap in Raycast's narrower block.
  const below = tidy(rows.slice(rules[1] + 1)).map((r) => r.replace(/ {4,}/g, "   "));
  return box + (below.length ? "\n\n```\n" + below.join("\n") + "\n```" : "");
}

/** The rows under the composer box (status line, subagent list), plain. */
function belowBox(p: Poll | undefined): string[] {
  if (!p) return [];
  const rows = p.bottom.map(plain);
  const rules = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
  return rules.length >= 2 ? rows.slice(rules[1] + 1) : [];
}

/** The permission mode from the status line ("auto", "plan", "accept edits", ...), if it shows one. */
export function modeName(p: Poll | undefined): string | undefined {
  const status = belowBox(p).find((r) => r.trim());
  const m = status && /(?:^|[·⏵⏸\s])((?:[a-z]+ )?(?:mode|edits)) on\b/i.exec(status);
  if (!m) return undefined;
  return m[1].replace(/ mode$/i, "").trim().toLowerCase();
}

export interface Subagent {
  kind: string; // general-purpose, an agent type, or a named workflow
  title: string; // what it's doing
  time: string; // runtime, two units ("13h 20m")
  tokens: string; // "517.6k"
}

/**
 * The running subagents from the list under the composer ("◯ general-purpose  Handing back the
 * report   13h 20m 19s · ↓ 517.6k tokens"); the main session's own row is skipped.
 */
export function subagents(p: Poll | undefined): Subagent[] {
  const out: Subagent[] = [];
  for (const raw of belowBox(p)) {
    const m = /^\s*(?:❯\s*)?[◯○●◉◐◑]\s+(\S+)\s*(.*)$/.exec(raw);
    if (!m || m[1] === "main") continue;
    const stats = /([0-9][0-9hms. ]*?)\s*·\s*↓\s*([0-9.]+[kmKM]?)\s*tokens\s*$/.exec(m[2]);
    const before = stats ? m[2].slice(0, stats.index) : m[2];
    // The middle is the task title -- or a progress bar for a workflow, which says less than its name.
    const title = before.replace(/[▰▱]+\s*\S*\s*·?\s*$/, "").replace(/\s{2,}/g, " ").trim();
    const time = (stats?.[1] ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
    out.push({ kind: m[1], title: title || m[1], time, tokens: stats?.[2] ?? "" });
  }
  return out;
}

/** The running subagents as one row of chips: inline code renders as a small grey pill. */
export function subagentChips(p: Poll | undefined): string {
  const chip = (s: Subagent) => {
    const t = s.title.length > 34 ? s.title.slice(0, 33) + "…" : s.title;
    return "`◯ " + [t, s.time, s.tokens].filter(Boolean).join(" · ").replace(/`/g, "'") + "`";
  };
  return subagents(p).map(chip).join(" ");
}

/**
 * Is Claude showing something the arrow keys move through -- a question, an @ / slash menu, or the
 * subagent list after ↓ ("↑/↓ to select", a ❯ on the selected row under the composer)? While it is,
 * the full-width view shows only that, so there is nothing for Raycast to scroll on ↑↓.
 */
export function isInteractive(p: Poll | undefined): boolean {
  if (!p) return false;
  if (p.needs || parseMenu(p)) return true;
  const rows = p.bottom.map(plain);
  const rules = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return false;
  const below = rows.slice(rules[1] + 1);
  return below.some((r) => /↑\/↓ to select|enter to (view|select)|esc to (go )?back/i.test(r) || /^\s*❯\s/.test(r));
}
