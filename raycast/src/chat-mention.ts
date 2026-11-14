// @ completion, shared by the one-line composer (the search bar) and the multi-line one (a Form
// TextArea). Neither tells an extension where the cursor is, so the multi-line composer infers it
// from each edit: the cursor sits at the end of what just changed. The token around it, if it
// starts with `@`, is the mention being typed -- anywhere in the message, not only at the end.

export interface Mention {
  start: number; // index of the `@`
  end: number; // end of the token (exclusive)
  query: string; // what's typed after `@`, up to the cursor
}

/** Where the cursor is after `prev` became `next`: the end of the changed span. */
export function editCursor(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return next.length - s;
}

export function mentionAt(text: string, cursor: number): Mention | undefined {
  let i = cursor;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  // The token must start with @ and the cursor must be past it (an @ right after the cursor isn't being typed).
  if (text[i] !== "@" || cursor <= i) return undefined;
  let e = cursor;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return { start: i, end: e, query: text.slice(i + 1, cursor) };
}

/** Replace the mention with `@path`; a directory stays open (no space) so you can keep drilling. */
export function applyMention(text: string, m: Mention, path: string): { text: string; cursor: number } {
  const ins = "@" + path + (path.endsWith("/") ? "" : " ");
  const after = text.slice(m.end).replace(/^ /, path.endsWith("/") ? " " : "");
  return { text: text.slice(0, m.start) + ins + after, cursor: m.start + ins.length };
}

/** Higher is better; -1 is no match. Basename hits beat path hits beat a scattered subsequence. */
function score(p: string, q: string): number {
  const lp = p.toLowerCase();
  const lq = q.toLowerCase();
  const trimmed = lp.endsWith("/") ? lp.slice(0, -1) : lp;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (base.startsWith(lq)) return 4000 - p.length;
  if (base.includes(lq)) return 3000 - p.length;
  if (lp.startsWith(lq)) return 2500 - p.length;
  if (lp.includes(lq)) return 2000 - p.length;
  let i = 0;
  for (const ch of lp) if (ch === lq[i] && ++i === lq.length) return 1000 - p.length;
  return -1;
}

/** Entries directly inside `dir` ("" = the top level), directories first. */
function children(all: string[], dir: string): string[] {
  const kids = all.filter((p) => p !== dir && p.startsWith(dir) && !p.slice(dir.length).replace(/\/$/, "").includes("/"));
  return [...kids.filter((p) => p.endsWith("/")), ...kids.filter((p) => !p.endsWith("/"))];
}

/** Suggestions for what's typed after `@`. A query ending in `/` lists that directory. */
export function candidates(all: string[], q: string, limit = 80): string[] {
  if (!q || q.endsWith("/")) return children(all, q).slice(0, limit);
  return all
    .map((p) => [p, score(p, q)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}
