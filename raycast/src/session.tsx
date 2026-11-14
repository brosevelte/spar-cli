// One Claude session, in two views that share one live connection (SessionStore):
//
//   Session (full width, what opens) -- Claude's composer area at the top (input line, and Claude's
//     own menu or question when it shows one), the conversation from the transcript under it as
//     markdown, newest exchange first. A Raycast Detail: full width, but no search bar -- so Enter
//     opens the typing view. ⌘1–⌘4 answer a question from here directly.
//   Typing (pushed by Enter) -- the search bar is a keyboard straight into Claude's composer; the left
//     column is Claude's menu when one is open (↑↓ move Claude's highlight, Enter accepts) and the
//     message history otherwise. Escape clears the keyboard, a second Escape goes back to full width.
//
// The store polls the transcript and the attached pane (term-backend.ts) and queues keystrokes, so
// both views see the same thing and the box is polled once.

import { Action, ActionPanel, Detail, Icon, List, closeMainWindow, environment, showToast, Toast, useNavigation } from "@raycast/api";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { attachFromClipboard, clipboardState, compactForUpload, safeUnlink } from "./clipboard";
import { Agent, Poll, ensureAttached, keys, newline, paste, poll, retype, upload } from "./term-backend";
import { Menu, composerMarkdown, parseMenu } from "./term-menu";
import { Transcript, conversationMarkdown } from "./term-transcript";
import { focusGhostty, prefs, q, tmux } from "./spark";

const POLL_MS = 700;
// The bar's resting value while typing: two invisible characters, in two spellings alternated so a
// reset is always a real change (React skips a state update to the same value).
const KEYBOARD = ["​​", "⁠⁠"];
const INVISIBLE = /[​⁠]/g;
const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

type Op = { k: "text"; s: string } | { k: "back"; n: number } | { k: "run"; fn: (pane: string) => Promise<void> };

// What the typing path did, one line per event, in the extension's support directory: when a
// keystroke doesn't reach Claude, this says whether Raycast delivered it, and what sending it did.
const TYPING_LOG = path.join(environment.supportPath, "typing.log");
function trace(msg: string) {
  try {
    mkdirSync(environment.supportPath, { recursive: true });
    appendFileSync(TYPING_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // tracing must never break typing
  }
}

// ---------------------------------------------------------------------------- the shared connection

export class SessionStore {
  transcript = new Transcript();
  poll?: Poll;
  pane?: string;
  version = 0;
  private offset = 0;
  private ops: Op[] = [];
  private pumping = false;
  private timer?: NodeJS.Timeout;
  private listeners = new Set<() => void>();

  constructor(readonly agent: Agent) {}

  start() {
    trace(`open ${this.agent.id} (${this.agent.name})`);
    ensureAttached(this.agent.id)
      .then((p) => {
        trace(`attached ${this.agent.id} -> ${p}`);
        this.pane = p;
        this.changed();
        this.tick();
        this.pump(); // anything typed while attaching was queued, waiting for the pane
      })
      .catch((e) => {
        trace(`attach failed ${this.agent.id}: ${e}`);
        showToast({ style: Toast.Style.Failure, title: "Couldn't attach", message: String(e) });
      });
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  async tick() {
    try {
      const p = await poll(this.agent.sessionId, this.offset, this.pane, 16);
      let changed = false;
      if (p.chunk) {
        this.transcript.feed(p.chunk);
        changed = true;
      }
      this.offset = p.size || this.offset;
      if (!this.poll || !sameBottom(this.poll, p)) {
        this.poll = p;
        changed = true;
      }
      if (changed) this.changed();
    } catch {
      // the next tick retries
    }
  }

  /** Queue a keystroke batch; consecutive text (or backspaces) merge into one ssh call. */
  enqueue(op: Op) {
    const prev = this.ops[this.ops.length - 1];
    if (prev && op.k === "text" && prev.k === "text") prev.s += op.s;
    else if (prev && op.k === "back" && prev.k === "back") prev.n += op.n;
    else this.ops.push(op);
    trace(`queue ${op.k === "text" ? JSON.stringify(op.s) : op.k === "back" ? `back ${op.n}` : "key"} (pane ${this.pane ?? "not attached yet"})`);
    this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.ops.length && this.pane) {
        const op = this.ops.shift()!;
        try {
          if (op.k === "text") await retype(this.pane, 0, op.s);
          else if (op.k === "back") await retype(this.pane, op.n, "");
          else await op.fn(this.pane);
          trace(`sent ${op.k === "text" ? JSON.stringify(op.s) : op.k} to ${this.pane}`);
        } catch (e) {
          trace(`send failed: ${e}`);
          showToast({ style: Toast.Style.Failure, title: "Couldn't reach Claude", message: String(e) });
        }
        this.tick();
      }
    } finally {
      this.pumping = false;
    }
  }

  run(fn: (pane: string) => Promise<void>) {
    if (!this.pane) {
      showToast({ style: Toast.Style.Failure, title: "Not attached yet" });
      return;
    }
    this.enqueue({ k: "run", fn });
  }

  press(...k: string[]) {
    this.run((p) => keys(p, ...k));
  }
}

function useStore(store: SessionStore) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(bump), [store]);
}

/** Same composer picture? (Rows, cursor and question flag; the transcript offset isn't part of it.) */
function sameBottom(a: Poll, b: Poll): boolean {
  return a.needs === b.needs && a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y && a.bottom.length === b.bottom.length && a.bottom.every((l, i) => l === b.bottom[i]);
}

// ---------------------------------------------------------------------------- images

// The `spark hotkeys` screenshot keys upload the image themselves and record its remote path here,
// keyed by the clipboard's changeCount; when that's still what's on the clipboard, reuse it.
const PASTE_STATE = path.join(homedir(), "Library", "Caches", "spark", "paste-state.json");

async function clipboardImageOnBox(): Promise<string> {
  try {
    const st = JSON.parse(readFileSync(PASTE_STATE, "utf8")) as { count?: number; state?: string; path?: string };
    if (st.state === "ok" && st.path && st.count === (await clipboardState()).count) return st.path;
  } catch {
    // no hotkey upload to reuse
  }
  const at = await compactForUpload(await attachFromClipboard());
  try {
    return await upload(readFileSync(at.path), path.basename(at.path));
  } finally {
    safeUnlink(at.path);
  }
}

function pasteImage(store: SessionStore) {
  store.run(async (p) => {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Attaching image…" });
    try {
      await paste(p, ` ${await clipboardImageOnBox()} `);
      toast.style = Toast.Style.Success;
      toast.title = "Image attached";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "No image to attach";
      toast.message = String(e);
    }
  });
}

/** Open a session in Ghostty: a new window in the layout session running `claude attach`. */
export async function openInGhostty(a: Pick<Agent, "id" | "name" | "cwd">) {
  await closeMainWindow({ clearRootSearch: true });
  await tmux(`new-window -t ${q(prefs.session + ":")} -n ${q(a.name.slice(0, 24))} -c ${q(a.cwd)} ${q(`$HOME/.local/bin/claude attach ${a.id}`)}`);
  await focusGhostty();
}

/** The composer area including Claude's menu, for the full-width view (no left column to list it in). */
function composerWithMenu(p: Poll | undefined, attached: boolean, menu: Menu | undefined): string {
  const box = composerMarkdown(p, attached);
  if (!menu || p?.needs) return box;
  const lines = menu.items.map((it, i) => `${i === menu.hi ? "❯" : " "} ${it.kind === "file" ? "+ " : ""}${it.label}${it.detail ? "  — " + it.detail : ""}`);
  return "```\n" + lines.join("\n") + "\n```\n\n" + box;
}

const title = (a: Agent, store: SessionStore) =>
  `${a.name} · ${store.poll?.needs ? "needs you" : a.state === "needs" ? "needs you" : a.state === "working" ? "working" : "done"} · ${short(a.cwd)}`;

// ---------------------------------------------------------------------------- full width

export function Session(props: { agent: Agent; onClose: () => void }) {
  const { push } = useNavigation();
  const store = useMemo(() => new SessionStore(props.agent), []);
  useStore(store);
  useEffect(() => {
    store.start();
    return () => {
      store.stop();
      props.onClose();
    };
  }, []);

  const p = store.poll;
  const menu = parseMenu(p);
  // This view is full width, which in Raycast means no search bar: it cannot take keystrokes. Say
  // so where the eye lands, instead of leaving typing to look broken.
  const hint = p?.needs ? "**↵ to answer** · ⌘1–⌘4 pick an option" : "**↵ to type** a message · ⌘K for more";
  const markdown = `${composerWithMenu(p, Boolean(store.pane), menu)}\n\n${hint}\n\n${conversationMarkdown(store.transcript.turns, 30)}`;
  const options = p?.needs ? (menu?.items ?? []) : [];

  return (
    <Detail
      navigationTitle={title(props.agent, store)}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title={p?.needs ? "Answer…" : "Type a Message"}
            icon={Icon.Pencil}
            onAction={() => {
              trace("typing view opened");
              push(<Typing store={store} />);
            }}
          />
          {options.map((o, i) =>
            o.digit && i < 9 ? (
              <Action
                key={o.digit}
                title={`${o.digit}. ${o.label}`}
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: ["cmd"], key: o.digit as "1" }}
                onAction={() => store.press(o.digit!)}
              />
            ) : null,
          )}
          <Action title="Paste Screenshot" icon={Icon.Image} shortcut={{ modifiers: ["ctrl"], key: "v" }} onAction={() => pasteImage(store)} />
          <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={() => store.press("Escape")} />
          <Action title="Cycle Mode" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={() => store.press("BTab")} />
          <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={() => openInGhostty(props.agent)} />
          <Action.CopyToClipboard title="Copy Session ID" content={props.agent.sessionId} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
        </ActionPanel>
      }
    />
  );
}

// ---------------------------------------------------------------------------- typing

function Typing(props: { store: SessionStore }) {
  const store = props.store;
  const a = store.agent;
  useStore(store);
  const [bar, setBar] = useState(KEYBOARD[0]);
  const [selected, setSelected] = useState<string>();
  const hiRef = useRef(-1); // where Claude's menu highlight is, as far as we've moved it
  const menuKey = useRef("");
  const resetBar = () => setBar((b) => (b === KEYBOARD[0] ? KEYBOARD[1] : KEYBOARD[0]));

  function onSearch(t: string) {
    trace(`search bar ${JSON.stringify(t)} (was ${JSON.stringify(bar)})`);
    const added = t.replace(INVISIBLE, "");
    const marks = (t.match(INVISIBLE) ?? []).length;
    if (added) {
      store.enqueue({ k: "text", s: added });
      resetBar();
    } else if (t === "") {
      setBar(""); // Escape (or ⌘⌫) cleared the bar: leave it, so the next Escape goes back
    } else if (marks < 2) {
      store.enqueue({ k: "back", n: 2 - marks });
      resetBar();
    }
  }

  // ---- Claude's menu on the left: the Raycast selection drives Claude's highlight
  const p = store.poll;
  const menu = parseMenu(p);
  const key = menu ? menu.items.map((i) => i.label).join("\n") : "";
  if (key !== menuKey.current) {
    menuKey.current = key;
    hiRef.current = menu?.hi ?? -1;
  }
  const moveTo = (i: number) => {
    const from = hiRef.current;
    // An @ menu highlights nothing until the first Down, which lands on the first entry.
    const n = from < 0 ? i + 1 : i - from;
    hiRef.current = i;
    if (n > 0) store.run((pn) => keys(pn, ...Array(n).fill("Down")));
    else if (n < 0) store.run((pn) => keys(pn, ...Array(-n).fill("Up")));
  };
  const accept = (i: number) => () => {
    const item = menu?.items[i];
    if (!item) return;
    if (item.kind === "option" && item.digit) return store.press(item.digit);
    if (hiRef.current !== i) moveTo(i);
    // A file completes into the composer (Tab); a command runs (Enter), as in the TUI.
    store.press(item.kind === "file" ? "Tab" : "Enter");
  };

  // ---- the right pane
  const turns = store.transcript.turns;
  const newestFirst = [...turns].reverse();
  const fromTurn = selected?.startsWith("t:") ? newestFirst.findIndex((t) => "t:" + t.id === selected) : 0;
  const shown = fromTurn > 0 ? turns.slice(0, turns.length - fromTurn) : turns;
  const detail = <List.Item.Detail markdown={`${composerMarkdown(p, Boolean(store.pane))}\n\n${conversationMarkdown(shown)}`} />;

  const actions = (primary: { title: string; icon: Icon; onAction: () => void }) => (
    <ActionPanel>
      <Action title={primary.title} icon={primary.icon} onAction={primary.onAction} />
      <ActionPanel.Section title="Claude">
        <Action title="Send (Enter)" icon={Icon.ArrowUpCircle} shortcut={{ modifiers: ["cmd", "shift"], key: "return" }} onAction={() => store.press("Enter")} />
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={() => store.run((pn) => newline(pn))} />
        <Action title="Paste Screenshot" icon={Icon.Image} shortcut={{ modifiers: ["ctrl"], key: "v" }} onAction={() => pasteImage(store)} />
        <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={() => store.press("Escape")} />
        <Action title="Tab" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} onAction={() => store.press("Tab")} />
        <Action title="Cycle Mode" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={() => store.press("BTab")} />
        <Action title="Clear Claude's Input" icon={Icon.Trash} shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }} onAction={() => store.press("C-u")} />
      </ActionPanel.Section>
    </ActionPanel>
  );

  const selectedId = menu ? `m:${Math.max(0, hiRef.current)}` : selected;
  const needs = Boolean(p?.needs);

  return (
    <List
      isShowingDetail
      filtering={false}
      throttle={false}
      searchText={bar}
      onSearchTextChange={onSearch}
      searchBarPlaceholder=""
      selectedItemId={selectedId}
      onSelectionChange={(id) => {
        if (!id) return;
        if (id.startsWith("m:")) {
          const i = Number(id.slice(2));
          if (menu && i !== Math.max(0, hiRef.current)) moveTo(i);
          return;
        }
        setSelected(id);
      }}
      navigationTitle={title(a, store)}
    >
      {menu ? (
        <List.Section title={menu.items[0].kind === "option" ? "Claude is asking" : menu.items[0].kind === "file" ? "@ files — Enter adds" : "Commands — Enter runs"}>
          {menu.items.map((item, i) => (
            <List.Item
              key={`m:${i}:${item.label}`}
              id={`m:${i}`}
              title={item.label}
              subtitle={item.detail}
              icon={item.kind === "file" ? (item.label.endsWith("/") ? Icon.Folder : Icon.Document) : item.kind === "command" ? Icon.Terminal : item.kind === "option" ? Icon.Circle : Icon.Dot}
              accessories={item.digit ? [{ text: item.digit }] : undefined}
              detail={detail}
              actions={actions({ title: item.kind === "option" ? "Choose" : item.kind === "file" ? "Add" : "Run", icon: Icon.ArrowRight, onAction: accept(i) })}
            />
          ))}
        </List.Section>
      ) : (
        <List.Section title={turns.length ? `${turns.length} exchanges` : "Conversation"}>
          {(newestFirst.length ? newestFirst.slice(0, 40) : [{ id: "none", prompt: "…", images: 0, parts: [] }]).map((t, i) => (
            <List.Item
              key={t.id}
              id={"t:" + t.id}
              title={t.prompt.trim().split("\n")[0] || "(image)"}
              icon={i === 0 ? Icon.Message : Icon.Clock}
              detail={detail}
              actions={actions({ title: needs ? "Answer (Enter)" : "Send (Enter)", icon: Icon.ArrowUpCircle, onAction: () => store.press("Enter") })}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}


