// "Claude Terminal": Claude Code on the Spark in a Raycast popover, as text.
//
//   left   -- "New session" and every session from `claude agents`, with its real state
//             (needs you / working / done). ↑↓ moves between them.
//   right  -- the selected session: Claude's live composer at the top (from the attached pane, so
//             Claude's own @ menu, slash menu and questions show there), then the conversation from
//             its transcript as markdown, newest exchange first.
//   search -- on "New session", the task to dispatch (`claude --bg`). On a session, a keyboard: it
//             holds two invisible characters, every keystroke goes straight into the session's
//             composer and the bar resets, so what you type shows up in the composer on the right.
//             Backspace arrives as one invisible character deleted; Escape (Raycast clears the
//             whole bar) as both, and is left alone so a second Escape goes back as usual.
//
// Sessions, state and the conversation are real values -- `claude agents --json`, the session's
// transcript JSONL -- and typing goes through a pane in Raycast's own tmux session running
// `claude attach <id>` (term-backend.ts), which shares the composer with anyone else attached, so a
// draft lives on the box and shows in Ghostty's agents view too.

import { Action, ActionPanel, Color, Detail, Icon, Keyboard, LaunchProps, List, LocalStorage, closeMainWindow, showToast, Toast, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachFromClipboard, clipboardState, safeUnlink } from "./clipboard";
import { Agent, AgentState, Poll, ensureAttached, keys, listAgents, newline, paste, poll, retype, startAgent, stopAgent, upload } from "./term-backend";
import { Transcript, conversationMarkdown } from "./term-transcript";
import { focusGhostty, listRepos, prefs, q, repoPath, tmux } from "./spark";

const LIST_POLL_MS = 3000;
const POLL_MS = 700;
const NEW_DIR = "newSessionDir";
const NEW = "new";
// The bar's resting value on a session: two invisible characters, in two spellings alternated so a
// reset is always a real change (React skips a state update to the same value, and the typed
// character would stay in the bar).
const KEYBOARD = ["​​", "⁠⁠"];
const INVISIBLE = /[​⁠]/g;

const STATE: Record<AgentState, { label: string; color: Color; icon: Icon }> = {
  needs: { label: "needs you", color: Color.Orange, icon: Icon.QuestionMarkCircle },
  working: { label: "working", color: Color.Green, icon: Icon.CircleProgress },
  done: { label: "done", color: Color.SecondaryText, icon: Icon.CheckCircle },
};

const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
const plain = (l: string) => l.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function age(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Claude's composer area as text: rule lines dropped, the cursor marked, trailing space trimmed. */
function composerMarkdown(p: Poll | undefined, attached: boolean): string {
  if (!attached) return "```\nattaching…\n```";
  if (!p) return "```\n❯\n```";
  const rows = p.bottom.map(plain);
  if (p.cursor && rows[p.cursor.y] !== undefined) {
    const r = rows[p.cursor.y];
    rows[p.cursor.y] = r.slice(0, p.cursor.x).padEnd(p.cursor.x) + "▌" + r.slice(p.cursor.x + 1);
  }
  const shown = rows.filter((r) => !/^\s*─{8,}/.test(r)).map((r) => r.replace(/\s+$/, ""));
  while (shown.length && !shown[0].trim()) shown.shift();
  const head = p.needs ? "**Claude is asking** — Enter picks the highlighted option · ⌘1 yes · ⌘3 no\n\n" : "";
  return head + "```\n" + (shown.join("\n") || "❯ ▌") + "\n```";
}

/** Open a session in Ghostty: a new window in the layout session running `claude attach`. */
async function openInGhostty(a: Pick<Agent, "id" | "name" | "cwd">) {
  await closeMainWindow({ clearRootSearch: true });
  await tmux(`new-window -t ${q(prefs.session + ":")} -n ${q(a.name.slice(0, 24))} -c ${q(a.cwd)} ${q(`$HOME/.local/bin/claude attach ${a.id}`)}`);
  await focusGhostty();
}

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
  const at = await attachFromClipboard();
  try {
    return await upload(readFileSync(at.path), at.path.split("/").pop()!);
  } finally {
    safeUnlink(at.path);
  }
}

// ---------------------------------------------------------------------------- the command

interface Live {
  transcript: Transcript;
  offset: number;
  poll?: Poll;
  version: number;
}

type Op = { k: "text"; s: string } | { k: "back"; n: number } | { k: "run"; fn: (pane: string) => Promise<void> };

export default function Command(props: LaunchProps<{ launchContext?: { agentId?: string } }>) {
  const { push } = useNavigation();
  const agents = useCachedPromise(listAgents, [], { keepPreviousData: true });
  const repos = useCachedPromise(listRepos, [], { keepPreviousData: true });
  const [selected, setSelected] = useState<string>(props.launchContext?.agentId ?? NEW);
  const [task, setTask] = useState("");
  const [bar, setBar] = useState(KEYBOARD[0]);
  const resetBar = () => setBar((b) => (b === KEYBOARD[0] ? KEYBOARD[1] : KEYBOARD[0]));
  const [dir, setDir] = useState<string>();
  const [, setRender] = useState(0);
  const panes = useRef(new Map<string, string>()); // agent id -> attached pane
  const live = useRef(new Map<string, Live>()); // agent id -> conversation state
  const ops = useRef<Op[]>([]);
  const pumping = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const all = agents.data ?? [];
  const agent = all.find((a) => a.id === selected);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const rerender = () => setRender((n) => n + 1);

  useEffect(() => {
    LocalStorage.getItem<string>(NEW_DIR).then((d) => setDir(d ?? (prefs.chatDefaultDir || prefs.srcDir)));
    const t = setInterval(agents.revalidate, LIST_POLL_MS);
    return () => clearInterval(t);
  }, []);

  // ---- the selected session: attach, then poll its transcript and composer together
  const tick = useCallback(async () => {
    const a = agentRef.current;
    if (!a) return;
    let l = live.current.get(a.id);
    if (!l) live.current.set(a.id, (l = { transcript: new Transcript(), offset: 0, version: 0 }));
    try {
      const p = await poll(a.sessionId, l.offset, panes.current.get(a.id), 16);
      let changed = false;
      if (p.chunk) {
        l.transcript.feed(p.chunk);
        l.version++;
        changed = true;
      }
      l.offset = p.size || l.offset;
      if (!l.poll || !sameBottom(l.poll, p)) {
        l.poll = p;
        changed = true;
      }
      if (changed && selectedRef.current === a.id) rerender();
    } catch {
      // the next tick retries; a dead link shows as a stale composer
    }
  }, []);

  useEffect(() => {
    if (!agent) return;
    resetBar();
    if (!panes.current.has(agent.id)) {
      ensureAttached(agent.id)
        .then((p) => {
          panes.current.set(agent.id, p);
          tick();
        })
        .catch((e) => showToast({ style: Toast.Style.Failure, title: "Couldn't attach", message: String(e) }));
    }
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [agent?.id]);

  // ---- the keyboard: queued, coalesced, in order, to the selected session's pane
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (ops.current.length) {
        const a = agentRef.current;
        const p = a && panes.current.get(a.id);
        if (!p) break;
        const op = ops.current.shift()!;
        try {
          if (op.k === "text") await retype(p, 0, op.s);
          else if (op.k === "back") await retype(p, op.n, "");
          else await op.fn(p);
        } catch (e) {
          showToast({ style: Toast.Style.Failure, title: "Couldn't reach Claude", message: String(e) });
        }
        tick();
      }
    } finally {
      pumping.current = false;
    }
  }, []);

  const enqueue = (op: Op) => {
    const prev = ops.current[ops.current.length - 1];
    if (prev && op.k === "text" && prev.k === "text") prev.s += op.s;
    else if (prev && op.k === "back" && prev.k === "back") prev.n += op.n;
    else ops.current.push(op);
    pump();
  };

  function onSearch(t: string) {
    if (selected === NEW || !agent) return setTask(t);
    const added = t.replace(INVISIBLE, "");
    const marks = (t.match(INVISIBLE) ?? []).length;
    if (added) {
      enqueue({ k: "text", s: added });
      resetBar();
    } else if (t === "") {
      setBar(""); // Escape (or ⌘⌫) cleared the bar: leave it, so the next Escape goes back
    } else if (marks < 2) {
      enqueue({ k: "back", n: 2 - marks });
      resetBar();
    }
  }

  const act = (fn: (pane: string) => Promise<void>) => () => {
    if (!agent || !panes.current.get(agent.id)) {
      showToast({ style: Toast.Style.Failure, title: "Not attached yet" });
      return;
    }
    enqueue({ k: "run", fn });
  };
  const press = (...k: string[]) => act((p) => keys(p, ...k));
  const pasteImage = act(async (p) => {
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

  async function dispatch() {
    const text = task.trim();
    if (!text || !dir) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Starting a session…", message: short(dir) });
    try {
      const id = await startAgent(dir, text);
      setTask("");
      toast.hide();
      await agents.revalidate();
      setSelected(id);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't start the session";
      toast.message = String(e);
    }
  }

  // ---- the right pane
  const l = agent ? live.current.get(agent.id) : undefined;
  const needs = Boolean(l?.poll?.needs) || agent?.state === "needs";
  const detailFor = (a: Agent) => {
    if (a.id !== selected) return <List.Item.Detail markdown="" />;
    const convo = l ? conversationMarkdown(l.transcript.turns) : "_loading…_";
    return <List.Item.Detail markdown={`${composerMarkdown(l?.poll, panes.current.has(a.id))}\n\n${convo}`} />;
  };

  const sessionActions = (a: Agent) => (
    <>
      <ActionPanel.Section title="Claude">
        <Action title={needs ? "Answer (Enter)" : "Send (Enter)"} icon={Icon.ArrowUpCircle} onAction={press("Enter")} />
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={act((p) => newline(p))} />
        <Action title="Paste Screenshot" icon={Icon.Image} shortcut={{ modifiers: ["ctrl"], key: "v" }} onAction={pasteImage} />
        <Action title="Option 1 (Yes)" icon={Icon.CheckCircle} shortcut={{ modifiers: ["cmd"], key: "1" }} onAction={press("1")} />
        <Action title="Option 2" icon={Icon.Circle} shortcut={{ modifiers: ["cmd"], key: "2" }} onAction={press("2")} />
        <Action title="Option 3 (No)" icon={Icon.XMarkCircle} shortcut={{ modifiers: ["cmd"], key: "3" }} onAction={press("3")} />
        <Action title="Menu Up" icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowUp" }} onAction={press("Up")} />
        <Action title="Menu Down" icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }} onAction={press("Down")} />
        <Action title="Tab (Accept Suggestion)" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} onAction={press("Tab")} />
        <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={press("Escape")} />
        <Action title="Cycle Mode" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={press("BTab")} />
        <Action title="Clear Claude's Input" icon={Icon.Trash} shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }} onAction={press("C-u")} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Session">
        <Action.Push
          title="Read Full Width"
          icon={Icon.Maximize}
          shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
          target={<Detail navigationTitle={a.name} markdown={l ? conversationMarkdown(l.transcript.turns, 60) : ""} />}
        />
        <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={() => openInGhostty(a)} />
        {a.state !== "done" && (
          <Action
            title="Stop Session"
            icon={Icon.Stop}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={async () => {
              await stopAgent(a.id);
              agents.revalidate();
            }}
          />
        )}
        <Action.CopyToClipboard title="Copy Session ID" content={a.sessionId} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
      </ActionPanel.Section>
    </>
  );

  const groups: [AgentState, Agent[]][] = [
    ["needs", all.filter((a) => a.state === "needs")],
    ["working", all.filter((a) => a.state === "working")],
    ["done", all.filter((a) => a.state === "done").slice(0, 30)],
  ];
  const dirs = [...new Set([prefs.chatDefaultDir || prefs.srcDir, "~", ...(repos.data ?? []).map(repoPath)])];
  const onNew = selected === NEW || !agent;

  return (
    <List
      isShowingDetail
      filtering={false}
      throttle={false}
      searchText={onNew ? task : bar}
      onSearchTextChange={onSearch}
      selectedItemId={selected}
      onSelectionChange={(id) => id && setSelected(id)}
      searchBarPlaceholder={onNew ? "Describe a task for a new session… (Enter starts it)" : ""}
      navigationTitle={agent ? `${agent.name} · ${needs ? "needs you" : STATE[agent.state].label} · ${short(agent.cwd)}` : "Claude on the Spark"}
      searchBarAccessory={
        onNew ? (
          <List.Dropdown
            tooltip="Where new sessions run"
            value={dir}
            onChange={(d) => {
              setDir(d);
              LocalStorage.setItem(NEW_DIR, d);
            }}
          >
            {dirs.map((d) => (
              <List.Dropdown.Item key={d} title={short(d)} value={d} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      <List.Item
        id={NEW}
        title={task.trim() || "New session"}
        icon={{ source: Icon.PlusCircle, tintColor: Color.Blue }}
        detail={
          <List.Item.Detail
            markdown={`### New session\n\nType the task in the search bar and press **Enter**: it starts \`claude --bg\` in **${short(dir ?? "")}** (change it with the dropdown), like the agents view, and opens it here.\n\nOn a session, the search bar is a keyboard straight into its composer: what you type shows up at the top of the conversation. **Enter** sends (or answers Claude's question), **⌘↵** adds a line, **⌃V** pastes a screenshot, **⌘K** has the rest.`}
          />
        }
        actions={
          <ActionPanel>
            <Action title="Start New Session" icon={Icon.PlusCircle} onAction={dispatch} />
          </ActionPanel>
        }
      />
      {groups.map(([state, list]) =>
        list.length ? (
          <List.Section key={state} title={STATE[state].label} subtitle={String(list.length)}>
            {list.map((a) => (
              <List.Item
                key={a.id}
                id={a.id}
                title={a.name}
                icon={{ source: STATE[a.state].icon, tintColor: STATE[a.state].color }}
                accessories={[{ text: age(a.startedAt), tooltip: `${short(a.cwd)} · ${a.raw}` }]}
                detail={detailFor(a)}
                actions={<ActionPanel>{sessionActions(a)}</ActionPanel>}
              />
            ))}
          </List.Section>
        ) : null,
      )}
    </List>
  );
}

/** Same composer picture? (Rows, cursor and question flag; the transcript offset isn't part of it.) */
function sameBottom(a: Poll, b: Poll): boolean {
  return a.needs === b.needs && a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y && a.bottom.length === b.bottom.length && a.bottom.every((l, i) => l === b.bottom[i]);
}
