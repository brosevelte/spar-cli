// One Claude session, full width: its transcript drawn terminal-style and pinned to the newest
// message, with the live bottom of its TUI underneath (composer, @ / slash menus, Claude's
// questions). A one-column Grid holds the image so it spans the window.
//
// The search bar is only a keyboard. It always holds one invisible character; every keystroke is
// sent straight into the session's composer and the bar is reset, so what you type appears where it
// lands -- in the composer, in the image, with its cursor. Deleting the invisible character is how
// Backspace arrives. Keys are queued and coalesced (a burst of letters is one ssh call), and go to a
// pane in Raycast's own tmux session running `claude attach <id>` (term-backend.ts), which shares the
// composer with anyone else attached: Ghostty's agents view shows the same draft.
//
// The image is only rewritten when what it shows changes -- a new message, a keystroke, a question
// -- because Raycast reloads (flashes) the image on every new frame.

import { Action, ActionPanel, Grid, Icon, List, environment, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { candidates } from "./chat-mention";
import { attachFromClipboard, safeUnlink } from "./clipboard";
import { Agent, COLS, Poll, ensureAttached, keys, listAgents, listFiles, newline, paste, poll, retype, upload } from "./term-backend";
import { screenSvg } from "./term-render";
import { Transcript, conversationLines } from "./term-transcript";

const POLL_MS = 900;
// The image is 4:3 at COLS columns: this many terminal rows fit (term-render's 14px font, 18px rows).
const SCREEN_ROWS = 31;
const MAX_BOTTOM = 16;
// Two different invisible characters, alternated so resetting the bar is always a real change.
const Z1 = "​";
const Z2 = "⁠";
const INVISIBLE = /[​⁠]/g;
const MENTION_AT_END = /(?:^|\s)@([^\s]*)$/;
const SCREENS = path.join(environment.supportPath, "screens");

const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

type Op = { k: "text"; s: string } | { k: "back"; n: number } | { k: "run"; fn: (pane: string) => Promise<void> };

export function Conversation(props: { agent: Agent; stateLabel: string; onClose: () => void; openInGhostty: () => void }) {
  const a = props.agent;
  const [bar, setBar] = useState(Z1);
  const [typed, setTyped] = useState(""); // what we've typed into the composer since the last send
  const [pane, setPane] = useState<string>();
  const [last, setLast] = useState<Poll>();
  const [turnsVersion, setTurnsVersion] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  const transcript = useRef(new Transcript());
  const offset = useRef(0);
  const sessionId = useRef(a.sessionId);
  const typedRef = useRef("");
  const ops = useRef<Op[]>([]);
  const working = useRef(false);
  const paneRef = useRef<string | undefined>(undefined);
  paneRef.current = pane;
  const imageRef = useRef<string | undefined>(undefined);
  imageRef.current = image;

  // ---- attach, then poll the transcript and the pane together
  useEffect(() => {
    mkdirSync(SCREENS, { recursive: true });
    ensureAttached(a.id)
      .then(setPane)
      .catch((e) => setError(`Couldn't attach: ${e}`));
    return () => {
      props.onClose();
      const img = imageRef.current;
      if (img) setTimeout(() => safeUnlink(img), 3000);
    };
  }, []);

  const tick = useCallback(async () => {
    try {
      if (!sessionId.current) sessionId.current = (await listAgents()).find((x) => x.id === a.id)?.sessionId ?? "";
      const p = await poll(sessionId.current, offset.current, paneRef.current, MAX_BOTTOM);
      if (p.chunk) {
        transcript.current.feed(p.chunk);
        setTurnsVersion((v) => v + 1);
      }
      offset.current = p.size || offset.current;
      setLast((prev) => (prev && sameBottom(prev, p) ? prev : p));
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [pane]);

  // ---- render, only when the picture changes
  useEffect(() => {
    const bottom = (last?.bottom ?? []).slice(-MAX_BOTTOM);
    const convoRows = SCREEN_ROWS - bottom.length;
    const all = conversationLines(transcript.current.turns, COLS);
    const end = Math.max(0, all.length - scroll);
    const shown = all.slice(Math.max(0, end - convoRows), end);
    const lines = [...Array(Math.max(0, convoRows - shown.length)).fill(""), ...shown, ...bottom];
    const cursor = last?.cursor && !scroll ? { x: last.cursor.x, y: convoRows + last.cursor.y } : undefined;
    const svg = screenSvg({ lines, cols: COLS, cursor });
    const file = path.join(SCREENS, `${a.id}-${createHash("sha1").update(svg).digest("hex").slice(0, 12)}.svg`);
    const previous = imageRef.current;
    if (file === previous) return;
    writeFileSync(file, svg);
    setImage(file);
    // Raycast caches images by path, so each frame is a new file; the old one goes once replaced.
    if (previous) setTimeout(() => safeUnlink(previous), 3000);
  }, [turnsVersion, last, scroll]);

  // ---- the keyboard: queued, coalesced, in order
  const pump = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      while (ops.current.length) {
        const p = paneRef.current;
        if (!p) break;
        const op = ops.current.shift()!;
        try {
          if (op.k === "text") await retype(p, 0, op.s);
          else if (op.k === "back") await retype(p, op.n, "");
          else await op.fn(p);
        } catch (e) {
          showToast({ style: Toast.Style.Failure, title: "Couldn't reach Claude", message: String(e) });
        }
      }
    } finally {
      working.current = false;
    }
    tick();
  }, []);

  const push = (op: Op) => {
    const q = ops.current;
    const prev = q[q.length - 1];
    // Not the one being sent right now (that was shifted off already), so merging is safe.
    if (prev && op.k === "text" && prev.k === "text") prev.s += op.s;
    else if (prev && op.k === "back" && prev.k === "back") prev.n += op.n;
    else q.push(op);
    pump();
  };

  const setTypedBoth = (t: string) => {
    typedRef.current = t;
    setTyped(t);
  };

  function onBar(t: string) {
    const added = t.replace(INVISIBLE, "");
    if (!added && t.length < bar.length) {
      // The invisible character was deleted: that's Backspace.
      setTypedBoth([...typedRef.current].slice(0, -1).join(""));
      push({ k: "back", n: 1 });
    } else if (added) {
      setTypedBoth(typedRef.current + added);
      push({ k: "text", s: added });
    }
    setBar(bar === Z1 ? Z2 : Z1);
  }

  const run = (fn: (pane: string) => Promise<void>, clearsTyped = false) => () => {
    if (!paneRef.current) {
      showToast({ style: Toast.Style.Failure, title: "Not attached yet" });
      return;
    }
    if (clearsTyped) setTypedBoth("");
    push({ k: "run", fn });
  };
  const press = (...k: string[]) => run((p) => keys(p, ...k));
  const send = run((p) => keys(p, "Enter"), true);
  const addLine = run((p) => newline(p), true);
  const clearInput = run((p) => keys(p, "C-u"), true);
  const pasteImage = run(async (p) => {
    const at = await attachFromClipboard();
    try {
      const remote = await upload(readFileSync(at.path), at.path.split("/").pop()!);
      await paste(p, ` ${remote} `);
      showToast({ style: Toast.Style.Success, title: "Image attached" });
    } finally {
      safeUnlink(at.path);
    }
  }, true);

  // ---- @ picker, from what you've typed
  const files = useCachedPromise(listFiles, [a.cwd], { keepPreviousData: true });
  const mention = MENTION_AT_END.exec(typed);
  const mentionQuery = mention ? mention[1] : undefined;
  const picks = useMemo(
    () => (mentionQuery === undefined || !files.data ? [] : candidates([...files.data.dirs, ...files.data.files], mentionQuery, 60)),
    [mentionQuery, files.data],
  );
  const insert = (p: string) => {
    const m = MENTION_AT_END.exec(typedRef.current);
    if (!m) return;
    const completion = "@" + p + (p.endsWith("/") ? "" : " ");
    setTypedBoth(typedRef.current.slice(0, typedRef.current.length - m[1].length - 1) + completion);
    push({ k: "back", n: m[1].length + 1 });
    push({ k: "text", s: completion });
  };

  const title = `${a.name} · ${last?.needs ? "needs you" : props.stateLabel} · ${short(a.cwd)}${scroll ? ` · scrolled — ⌥↓` : ""}`;

  const keyActions = (
    <>
      <ActionPanel.Section title="Message">
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={addLine} />
        <Action title="Paste Image" icon={Icon.Image} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={pasteImage} />
        <Action title="Clear Claude's Input" icon={Icon.Trash} shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }} onAction={clearInput} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Answer and Navigate">
        <Action title="Option 1 (Yes)" icon={Icon.CheckCircle} shortcut={{ modifiers: ["cmd"], key: "1" }} onAction={press("1")} />
        <Action title="Option 2" icon={Icon.Circle} shortcut={{ modifiers: ["cmd"], key: "2" }} onAction={press("2")} />
        <Action title="Option 3 (No)" icon={Icon.XMarkCircle} shortcut={{ modifiers: ["cmd"], key: "3" }} onAction={press("3")} />
        <Action title="Up" icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowUp" }} onAction={press("Up")} />
        <Action title="Down" icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }} onAction={press("Down")} />
        <Action title="Tab" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} onAction={press("Tab")} />
        <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={press("Escape")} />
        <Action title="Cycle Mode" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={press("BTab")} />
      </ActionPanel.Section>
      <ActionPanel.Section title="View">
        <Action title="Scroll Up" icon={Icon.ChevronUp} shortcut={{ modifiers: ["opt"], key: "arrowUp" }} onAction={() => setScroll((s) => s + 12)} />
        <Action title="Scroll Down" icon={Icon.ChevronDown} shortcut={{ modifiers: ["opt"], key: "arrowDown" }} onAction={() => setScroll((s) => Math.max(0, s - 12))} />
        <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={props.openInGhostty} />
      </ActionPanel.Section>
    </>
  );

  if (mentionQuery !== undefined && picks.length) {
    return (
      <List searchText={bar} onSearchTextChange={onBar} filtering={false} throttle={false} navigationTitle={title} searchBarPlaceholder="">
        <List.Section title={`@${mentionQuery} — Enter inserts`}>
          {picks.map((p) => (
            <List.Item
              key={p}
              title={p}
              icon={p.endsWith("/") ? Icon.Folder : Icon.Document}
              actions={
                <ActionPanel>
                  <Action title="Insert" icon={Icon.Plus} onAction={() => insert(p)} />
                  {keyActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      </List>
    );
  }

  return (
    <Grid
      columns={1}
      aspectRatio="4/3"
      fit={Grid.Fit.Contain}
      filtering={false}
      throttle={false}
      searchText={bar}
      onSearchTextChange={onBar}
      navigationTitle={title}
      searchBarPlaceholder=""
      isLoading={!image && !error}
    >
      {error && !image ? (
        <Grid.EmptyView icon={Icon.Warning} title="Can't reach the session" description={error} />
      ) : image ? (
        <Grid.Item
          content={{ source: image }}
          actions={
            <ActionPanel>
              <Action title={last?.needs ? "Answer (Enter)" : "Send"} icon={Icon.ArrowUpCircle} onAction={send} />
              {keyActions}
            </ActionPanel>
          }
        />
      ) : null}
    </Grid>
  );
}

/** Same picture? (Cursor and rows; the transcript offset is not part of the picture.) */
function sameBottom(a: Poll, b: Poll): boolean {
  return a.needs === b.needs && a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y && a.bottom.length === b.bottom.length && a.bottom.every((l, i) => l === b.bottom[i]);
}
