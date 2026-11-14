// The Mac half of "Chat with Claude": talks to assets/spark-chat.py on the box, and keeps the
// things that must survive Raycast closing its window -- the chat list, each chat's draft and its
// pasted images -- in LocalStorage and the extension's support directory.
//
// Claude never runs here. Raycast unloads a command when its window closes, so each turn is a
// detached `claude -p` on the box (see the helper's docstring) and this side only sends and reads.

import { Clipboard, LocalStorage, environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { prefs, runWithInput } from "./spark";

const run = promisify(execFile);

// ---------------------------------------------------------------------------- the box helper

// Content-addressed on the box, so an updated extension uploads its own helper on first use and an
// old one keeps working: there is nothing to install and no version to keep in step.
const HELPER_SRC = readFileSync(path.join(environment.assetsPath, "spark-chat.py"), "utf8");
const HELPER = `~/.cache/spark-chat/h-${createHash("sha256").update(HELPER_SRC).digest("hex").slice(0, 12)}.py`;

async function deployHelper(): Promise<void> {
  // The remote login shell is fish: `;` and `&&` both parse there, and nothing here needs quoting.
  await runWithInput("/usr/bin/ssh", [prefs.sshHost, `mkdir -p ~/.cache/spark-chat && cat > ${HELPER}.tmp && mv ${HELPER}.tmp ${HELPER}`], HELPER_SRC, 15000);
}

async function call<T>(req: Record<string, unknown>, timeout = 15000): Promise<T> {
  const input = JSON.stringify(req);
  const go = () => runWithInput("/usr/bin/ssh", [prefs.sshHost, `python3 ${HELPER}`], input, timeout);
  let raw: string;
  try {
    raw = await go();
  } catch (e) {
    if (!/can't open file|No such file/.test(String(e))) throw e;
    await deployHelper();
    raw = await go();
  }
  return JSON.parse(raw) as T;
}

export interface Part {
  t: "text" | "tool";
  text?: string;
  name?: string;
  desc?: string;
  error?: boolean;
}

export interface Turn {
  id: string;
  ts: string | null;
  prompt: string;
  images: number;
  files: string[];
  parts: Part[];
}

export interface ShowResult {
  running: boolean;
  title: string | null;
  turns: Turn[];
  error: string | null;
}

export interface Attachment {
  path: string; // local file in the support directory, deleted once sent
  mediaType: string;
  name: string;
}

export async function show(sid: string): Promise<ShowResult> {
  return call<ShowResult>({ cmd: "show", sid, limit: 40 });
}

export async function send(chat: Chat, text: string, attachments: Attachment[]): Promise<void> {
  const images = attachments.map((a) => ({ media_type: a.mediaType, data: readFileSync(a.path).toString("base64") }));
  const r = await call<{ ok: boolean; error?: string }>(
    { cmd: "send", sid: chat.id, cwd: chat.cwd, text, images, mode: prefs.chatPermissionMode || "acceptEdits", model: prefs.chatModel || undefined },
    90000,
  );
  if (!r.ok) throw new Error(r.error ?? "send failed");
}

export async function stop(sid: string): Promise<boolean> {
  return (await call<{ stopped: boolean }>({ cmd: "stop", sid })).stopped;
}

export interface FileIndex {
  cwd: string;
  files: string[];
  dirs: string[];
}

export async function files(cwd: string): Promise<FileIndex> {
  return call<FileIndex>({ cmd: "files", cwd }, 30000);
}

// ---------------------------------------------------------------------------- chats + drafts

export interface Chat {
  id: string; // the Claude session id, chosen here so it is known before the first turn lands
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

const CHATS = "chats";
const CURRENT = "currentChat";

export async function loadChats(): Promise<Chat[]> {
  const raw = await LocalStorage.getItem<string>(CHATS);
  return raw ? (JSON.parse(raw) as Chat[]) : [];
}

async function saveChats(chats: Chat[]): Promise<void> {
  await LocalStorage.setItem(CHATS, JSON.stringify(chats));
}

export async function upsertChat(chat: Chat): Promise<void> {
  const chats = (await loadChats()).filter((c) => c.id !== chat.id);
  await saveChats([chat, ...chats].sort((a, b) => b.updatedAt - a.updatedAt));
}

export async function removeChat(id: string): Promise<void> {
  await saveChats((await loadChats()).filter((c) => c.id !== id));
  const d = await loadDraft(id);
  d.attachments.forEach((a) => safeUnlink(a.path));
  await LocalStorage.removeItem(`draft:${id}`);
  if ((await LocalStorage.getItem<string>(CURRENT)) === id) await LocalStorage.removeItem(CURRENT);
}

export function newChat(cwd: string): Chat {
  const now = Date.now();
  return { id: randomUUID(), cwd, title: "New chat", createdAt: now, updatedAt: now };
}

export async function currentChatId(): Promise<string | undefined> {
  return LocalStorage.getItem<string>(CURRENT);
}

export async function setCurrentChat(id: string): Promise<void> {
  await LocalStorage.setItem(CURRENT, id);
}

export async function loadDraft(id: string): Promise<Draft> {
  const raw = await LocalStorage.getItem<string>(`draft:${id}`);
  const d: Draft = raw ? JSON.parse(raw) : { text: "", attachments: [] };
  // An attachment whose file is gone (support dir cleared) would fail the send: drop it.
  d.attachments = d.attachments.filter((a) => exists(a.path));
  return d;
}

export async function saveDraft(id: string, d: Draft): Promise<void> {
  if (!d.text && !d.attachments.length) await LocalStorage.removeItem(`draft:${id}`);
  else await LocalStorage.setItem(`draft:${id}`, JSON.stringify(d));
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
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
