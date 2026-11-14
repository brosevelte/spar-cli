// The image on the Mac's clipboard, as a file: a screenshot's PNG/TIFF data, or an image file copied
// in Finder. Used by the Claude Terminal's Image action, which uploads it to the box.

import { Clipboard, environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Attachment {
  path: string;
  mediaType: string;
  name: string;
}

export function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------- clipboard images

const ATTACH_DIR = path.join(environment.supportPath, "attachments");

// Same extraction as `spark paste` (spar_cli/main.py, _CLIPBOARD_PNG): NSData.writeToFile is ~80ms
// for a 4k screenshot where AppleScript's own write takes over a second. With no path it only
// reports the pasteboard's changeCount and whether an image is there, which is how the chat offers
// "attach the screenshot you just took" without reading the bytes.
const CLIPBOARD_JXA = `
ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.generalPasteboard;
  var kind = "png", d = pb.dataForType($.NSPasteboardTypePNG);
  if (d.isNil()) { kind = "tiff"; d = pb.dataForType($.NSPasteboardTypeTIFF); }
  if (d.isNil()) return JSON.stringify({ count: Number(pb.changeCount), image: false });
  if (argv.length && !d.writeToFileAtomically(argv[0], true)) throw new Error("write failed");
  return JSON.stringify({ count: Number(pb.changeCount), image: true, kind: kind });
}`;

export interface ClipboardState {
  count: number;
  image: boolean;
  kind?: "png" | "tiff";
}

export async function clipboardState(): Promise<ClipboardState> {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLIPBOARD_JXA]);
  return JSON.parse(stdout) as ClipboardState;
}

const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// The API takes at most ~5MB of base64 per image (3.75MB of bytes). Retina screenshots usually fit;
// a bigger one is scaled down by its long edge until it does, and only then.
const MAX_BYTES = 3_700_000;

async function fitForApi(file: string): Promise<void> {
  for (const edge of [3000, 2400, 1800, 1400]) {
    if (statSync(file).size <= MAX_BYTES) return;
    await run("/usr/bin/sips", ["-Z", String(edge), file, "--out", file]);
  }
}

/** Save what's on the clipboard -- image data (a screenshot) or a copied image file -- as an attachment. */
export async function attachFromClipboard(): Promise<Attachment> {
  mkdirSync(ATTACH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copied = await Clipboard.read();
  const fromFile = copied.file ? decodeURI(copied.file.replace(/^file:\/\//, "")) : undefined;
  if (fromFile && IMAGE_EXT[path.extname(fromFile).toLowerCase()]) {
    const ext = path.extname(fromFile).toLowerCase();
    const dest = path.join(ATTACH_DIR, `file-${stamp}${ext}`);
    await run("/bin/cp", [fromFile, dest]);
    if (ext !== ".gif") await fitForApi(dest);
    return { path: dest, mediaType: IMAGE_EXT[ext], name: path.basename(fromFile) };
  }
  const raw = path.join(ATTACH_DIR, `clip-${stamp}.img`);
  const st = JSON.parse((await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLIPBOARD_JXA, raw])).stdout) as ClipboardState;
  if (!st.image) throw new Error("no image on the clipboard");
  const dest = path.join(ATTACH_DIR, `clip-${stamp}.png`);
  if (st.kind === "tiff") {
    await run("/usr/bin/sips", ["-s", "format", "png", raw, "--out", dest]);
    safeUnlink(raw);
  } else {
    await run("/bin/mv", [raw, dest]);
  }
  await fitForApi(dest);
  return { path: dest, mediaType: "image/png", name: "Screenshot" };
}
