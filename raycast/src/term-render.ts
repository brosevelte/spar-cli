// Draw a tmux pane capture (`capture-pane -p -e`: text with SGR colour escapes) as an SVG, so a
// Raycast detail pane can show the real Claude Code TUI -- colours, layout, cursor -- where markdown
// alone can only show plain text. Rendering a terminal as an SVG data URI in a detail pane is the
// technique PromptCast uses (WerrySs, raycast/extensions extensions/codex-claude-cli, MIT); this is
// an independent, much smaller implementation of it.
//
// Every run of text is placed at its cell's x and stretched to its exact cell width with
// textLength, so columns line up whatever monospace font the renderer substitutes.

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface Span {
  col: number;
  width: number;
  text: string;
  style: Style;
}

const FG = "#d6d6d6";
const BG = "#17171a";
// xterm's 16 colours, a little softened for a dark background.
const BASE16 = [
  "#2e2e33", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#c9d1d9",
  "#636e7b", "#ff7b72", "#7ee787", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];

function color256(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const v = (x: number) => (x ? 55 + x * 40 : 0);
    return rgb(v(Math.floor(i / 36)), v(Math.floor(i / 6) % 6), v(i % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}

const rgb = (r: number, g: number, b: number) => "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");

function applySgr(style: Style, params: number[]): Style {
  const s = { ...style };
  if (!params.length) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.keys(s).forEach((k) => delete (s as Record<string, unknown>)[k]);
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) s.bold = s.dim = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8];
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8];
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      let c: string | undefined;
      if (params[i + 1] === 5) {
        c = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        c = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
        i += 4;
      }
      if (c) {
        if (p === 38) s.fg = c;
        else s.bg = c;
      }
    }
  }
  return s;
}

/** Terminal cell width of a code point: 2 for wide CJK and emoji, 0 for combining marks, else 1. */
function cellWidth(cp: number): number {
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;

/** One captured line into styled spans positioned by terminal column. */
export function parseLine(line: string): Span[] {
  const spans: Span[] = [];
  let style: Style = {};
  let col = 0;
  let i = 0;
  const push = (ch: string, w: number) => {
    const last = spans[spans.length - 1];
    if (last && sameStyle(last.style, style) && last.col + last.width === col) {
      last.text += ch;
      last.width += w;
    } else {
      spans.push({ col, width: w, text: ch, style });
    }
    col += w;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "\x1b") {
      const n = line[i + 1];
      if (n === "[") {
        let j = i + 2;
        while (j < line.length && !/[@-~]/.test(line[j])) j++;
        if (line[j] === "m") {
          const params = line
            .slice(i + 2, j)
            .split(/[;:]/)
            .filter((x) => x !== "")
            .map(Number);
          style = applySgr(style, params);
        }
        i = j + 1;
        continue;
      }
      if (n === "]") {
        // OSC (hyperlinks, titles): skip to BEL or ST.
        let j = i + 2;
        while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
        i = line[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += 2;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp < 0x20) continue;
    const w = cellWidth(cp);
    if (w === 0) {
      const last = spans[spans.length - 1];
      if (last) last.text += ch;
      continue;
    }
    push(ch, w);
  }
  return spans;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Screen {
  lines: string[]; // captured rows, with escapes
  cols: number;
  cursor?: { x: number; y: number }; // row index into `lines`
}

const FONT = 14;
const CW = FONT * 0.6;
const LH = Math.round(FONT * 1.32);
const PAD = 14;

/** The screen as an SVG data-URI image in markdown, ready for a List.Item.Detail. */
export function screenMarkdown(screen: Screen, header?: string): string {
  const rows = screen.lines.length;
  const width = Math.ceil(screen.cols * CW + PAD * 2);
  const top = PAD + (header ? LH : 0);
  const height = Math.ceil(top + rows * LH + PAD);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  out.push(`<rect width="100%" height="100%" rx="10" fill="${BG}"/>`);
  if (header) {
    out.push(`<text x="${PAD}" y="${PAD + FONT * 0.8}" fill="${FG}" opacity="0.5" font-family="-apple-system, sans-serif" font-size="${FONT - 2}">${xml(header)}</text>`);
  }
  out.push(`<g font-family="SFMono-Regular, Menlo, Monaco, monospace" font-size="${FONT}" xml:space="preserve">`);
  screen.lines.forEach((line, r) => {
    const yTop = top + r * LH;
    const yText = yTop + FONT;
    for (const sp of parseLine(line)) {
      let fg = sp.style.fg ?? FG;
      let bg = sp.style.bg;
      if (sp.style.inverse) [fg, bg] = [bg ?? BG, fg];
      const x = PAD + sp.col * CW;
      const w = sp.width * CW;
      if (bg) out.push(`<rect x="${x.toFixed(1)}" y="${yTop}" width="${w.toFixed(1)}" height="${LH}" fill="${bg}"/>`);
      if (!sp.text.trim()) continue;
      const attrs = [
        `x="${x.toFixed(1)}"`,
        `y="${yText}"`,
        `fill="${fg}"`,
        sp.width > 1 ? `textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : "",
        sp.style.bold ? `font-weight="700"` : "",
        sp.style.italic ? `font-style="italic"` : "",
        sp.style.dim ? `opacity="0.55"` : "",
        sp.style.underline ? `text-decoration="underline"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      // Spaces as NBSP: renderers that ignore xml:space collapse a run's edge spaces, and textLength
      // then stretches the glyphs over the gap (words glued together at every colour change).
      out.push(`<text ${attrs}>${xml(sp.text).replace(/ /g, " ")}</text>`);
    }
  });
  if (screen.cursor && screen.cursor.y >= 0 && screen.cursor.y < rows) {
    const x = PAD + screen.cursor.x * CW;
    out.push(`<rect x="${x.toFixed(1)}" y="${top + screen.cursor.y * LH + 2}" width="${CW.toFixed(1)}" height="${LH - 3}" fill="#7ee787" opacity="0.7"/>`);
  }
  out.push("</g></svg>");
  return `![terminal](data:image/svg+xml;base64,${Buffer.from(out.join(""), "utf8").toString("base64")})`;
}
