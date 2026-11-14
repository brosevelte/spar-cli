// "Claude Terminal": Claude Code on the Spark in a Raycast popover, as text, shaped like the TUI's
// agents view.
//
//   Sessions (full width) -- "New session", then every session from `claude agents` with the summary
//     line and PRs the agents view shows (~/.claude/jobs/<id>/state.json). Type a task and press
//     Enter to dispatch a new background session; Enter on a session opens it.
//   A session -- right: Claude's live composer (from the attached pane) above the conversation from
//     its transcript, as markdown, newest exchange first. Left: Claude's own menu whenever it shows
//     one (@ files, slash commands, the options of a question) -- moving the Raycast selection with
//     ↑↓ moves Claude's highlight, Enter accepts -- and otherwise the exchanges, newest first, which
//     scroll the conversation to the one selected. Escape twice goes back to the sessions.
//
// In a session the search bar is a keyboard: it holds two invisible characters, every keystroke goes
// straight into the session's composer and the bar resets, so what you type shows up in the composer
// on the right. Backspace arrives as one invisible character deleted; Escape (Raycast clears the bar)
// as both, and is left alone so the second Escape goes back. Typing goes through a pane in Raycast's
// own tmux session running `claude attach <id>` (term-backend.ts), which shares the composer with
// anyone else attached, so a draft lives on the box and shows in Ghostty's agents view too.

import { Action, ActionPanel, Color, Detail, Icon, Keyboard, LaunchProps, List, LocalStorage, closeMainWindow, showToast, Toast, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachFromClipboard, clipboardState, compactForUpload, safeUnlink } from "./clipboard";
import { Agent, AgentState, Poll, ensureAttached, keys, listAgents, newline, paste, poll, retype, startAgent, stopAgent, upload } from "./term-backend";
import { composerMarkdown, parseMenu } from "./term-menu";
import { Transcript, Turn, conversationMarkdown } from "./term-transcript";
import { focusGhostty, listRepos, prefs, q, repoPath, tmux } from "./spark";

const LIST_POLL_MS = 3000;
const POLL_MS = 700;
const NEW_DIR = "newSessionDir";
// The bar's resting value in a session: two invisible characters, in two spellings alternated so a
// reset is always a real change (React skips a state update to the same value, and the typed
// character would stay in the bar).
const KEYBOARD = ["​​", "⁠⁠"];
const INVISIBLE = /[​⁠]/g;

const STATE: Record<AgentState, { label: string; section: string; color: Color; icon: Icon }> = {
  needs: { label: "needs you", section: "Awaiting input", color: Color.Orange, icon: Icon.QuestionMarkCircle },
  working: { label: "working", section: "Working", color: Color.Green, icon: Icon.CircleProgress },
  done: { label: "done", section: "Completed", color: Color.SecondaryText, icon: Icon.CheckCircle },
};

const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

function age(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Open a session in Ghostty: a new window in the layout session running `claude attach`. */
async function openInGhostty(a: Pick<Agent, "id" | "name" | "cwd">) {
  await closeMainWindow({ clearRootSearch: true });
  await tmux(`new-window -t ${q(prefs.session + ":")} -n ${q(a.name.slice(0, 24))} -c ${q(a.cwd)} ${q(`$HOME/.local/bin/claude attach ${a.id}`)}`);
  await focusGhostty();
}

// ---------------------------------------------------------------------------- sessions

export default function Command(props: LaunchProps<{ launchContext?: { agentId?: string } }>) {
  const { push } = useNavigation();
  const agents = useCachedPromise(listAgents, [], { keepPreviousData: true });
  const repos = useCachedPromise(listRepos, [], { keepPreviousData: true });
  const [task, setTask] = useState("");
  const [dir, setDir] = useState<string>();
  const launched = useRef(false);

  useEffect(() => {
    LocalStorage.getItem<string>(NEW_DIR).then((d) => setDir(d ?? (prefs.chatDefaultDir || prefs.srcDir)));
    const t = setInterval(agents.revalidate, LIST_POLL_MS);
    return () => clearInterval(t);
  }, []);

  const open = useCallback((a: Agent) => push(<Session agent={a} onClose={agents.revalidate} />), []);

  useEffect(() => {
    const want = props.launchContext?.agentId;
    if (launched.current || !want || !agents.data) return;
    launched.current = true;
    const a = agents.data.find((x) => x.id === want);
    if (a) open(a);
  }, [agents.data]);

  async function dispatch() {
    const text = task.trim();
    if (!text || !dir) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Starting a session…", message: short(dir) });
    try {
      const id = await startAgent(dir, text);
      setTask("");
      toast.hide();
      const list = await listAgents();
      agents.revalidate();
      const a = list.find((x) => x.id === id);
      if (a) open(a);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't start the session";
      toast.message = String(e);
    }
  }

  const all = agents.data ?? [];
  const dirs = [...new Set([prefs.chatDefaultDir || prefs.srcDir, "~", ...(repos.data ?? []).map(repoPath)])];
  const groups: AgentState[] = ["needs", "working", "done"];

  return (
    <List
      isLoading={agents.isLoading && !agents.data}
      filtering={false}
      searchText={task}
      onSearchTextChange={setTask}
      searchBarPlaceholder="Describe a task for a new session…"
      navigationTitle={`${all.filter((a) => a.state === "needs").length} awaiting input · ${all.filter((a) => a.state === "working").length} working · ${all.filter((a) => a.state === "done").length} completed`}
      searchBarAccessory={
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
      }
    >
      <List.Item
        id="new"
        title={task.trim() || "New session"}
        subtitle={task.trim() ? `Enter starts it in ${short(dir ?? "")}` : `type a task above · runs in ${short(dir ?? "")}`}
        icon={{ source: Icon.PlusCircle, tintColor: Color.Blue }}
        actions={
          <ActionPanel>
            <Action title="Start New Session" icon={Icon.PlusCircle} onAction={dispatch} />
          </ActionPanel>
        }
      />
      {groups.map((state) => {
        const list = all.filter((a) => a.state === state).slice(0, state === "done" ? 60 : undefined);
        return list.length ? (
          <List.Section key={state} title={STATE[state].section} subtitle={String(list.length)}>
            {list.map((a) => (
              <List.Item
                key={a.id}
                id={a.id}
                title={a.name}
                subtitle={a.detail}
                icon={{ source: STATE[a.state].icon, tintColor: STATE[a.state].color }}
                accessories={[...(a.prs ? [{ text: a.prs === 1 ? "1 PR" : `${a.prs} PRs` }] : []), { text: age(a.updatedAt), tooltip: `${short(a.cwd)} · ${a.raw}` }]}
                actions={
                  <ActionPanel>
                    <Action title="Open" icon={Icon.Message} onAction={() => open(a)} />
                    {task.trim() && <Action title="Start New Session" icon={Icon.PlusCircle} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={dispatch} />}
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
                    <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={agents.revalidate} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ) : null;
      })}
    </List>
  );
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
  const at = await compactForUpload(await attachFromClipboard());
  try {
    return await upload(readFileSync(at.path), path.basename(at.path));
  } finally {
    safeUnlink(at.path);
  }
}

// ---------------------------------------------------------------------------- a session

type Op = { k: "text"; s: string } | { k: "back"; n: number } | { k: "run"; fn: (pane: string) => Promise<void> };

function Session(props: { agent: Agent; onClose: () => void }) {
  const a = props.agent;
  const [bar, setBar] = useState(KEYBOARD[0]);
  const [pane, setPane] = useState<string>();
  const [last, setLast] = useState<Poll>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selected, setSelected] = useState<string>();
  const transcript = useRef(new Transcript());
  const offset = useRef(0);
  const ops = useRef<Op[]>([]);
  const pumping = useRef(false);
  const paneRef = useRef<string | undefined>(undefined);
  paneRef.current = pane;
  const hiRef = useRef(-1); // where Claude's menu highlight is, as far as we've moved it
  const menuKey = useRef("");

  const resetBar = () => setBar((b) => (b === KEYBOARD[0] ? KEYBOARD[1] : KEYBOARD[0]));

  // ---- attach, then poll the transcript and the composer together
  const tick = useCallback(async () => {
    try {
      const p = await poll(a.sessionId, offset.current, paneRef.current, 16);
      if (p.chunk) {
        transcript.current.feed(p.chunk);
        setTurns([...transcript.current.turns]);
      }
      offset.current = p.size || offset.current;
      setLast((prev) => (prev && sameBottom(prev, p) ? prev : p));
    } catch {
      // the next tick retries
    }
  }, []);

  useEffect(() => {
    ensureAttached(a.id)
      .then((p) => {
        setPane(p);
        paneRef.current = p;
        tick();
      })
      .catch((e) => showToast({ style: Toast.Style.Failure, title: "Couldn't attach", message: String(e) }));
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      clearInterval(t);
      props.onClose();
    };
  }, []);

  // ---- the keyboard: queued, coalesced, in order
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
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

  const run = (fn: (pane: string) => Promise<void>) => () => {
    if (!paneRef.current) {
      showToast({ style: Toast.Style.Failure, title: "Not attached yet" });
      return;
    }
    enqueue({ k: "run", fn });
  };
  const press = (...k: string[]) => run((p) => keys(p, ...k));
  const pasteImage = run(async (p) => {
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

  // ---- Claude's menu on the left: the Raycast selection drives Claude's highlight
  const menu = useMemo(() => parseMenu(last), [last]);
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
    if (n > 0) enqueue({ k: "run", fn: (p) => keys(p, ...Array(n).fill("Down")) });
    else if (n < 0) enqueue({ k: "run", fn: (p) => keys(p, ...Array(-n).fill("Up")) });
  };
  const accept = (i: number) => () => {
    const item = menu?.items[i];
    if (!item) return;
    if (item.kind === "option" && item.digit) return press(item.digit)();
    if (hiRef.current !== i) moveTo(i);
    // A file completes into the composer (Tab); a command runs (Enter), as in the TUI.
    press(item.kind === "file" ? "Tab" : "Enter")();
  };

  // ---- the right pane
  const newestFirst = useMemo(() => [...turns].reverse(), [turns]);
  const fromTurn = selected?.startsWith("t:") ? newestFirst.findIndex((t) => "t:" + t.id === selected) : 0;
  const shownTurns = fromTurn > 0 ? turns.slice(0, turns.length - fromTurn) : turns;
  const markdown = `${composerMarkdown(last, Boolean(pane))}\n\n${conversationMarkdown(shownTurns)}`;
  const detail = <List.Item.Detail markdown={markdown} />;
  const needs = Boolean(last?.needs) || a.state === "needs";

  const actions = (primary: { title: string; icon: Icon; onAction: () => void }) => (
    <ActionPanel>
      <Action title={primary.title} icon={primary.icon} onAction={primary.onAction} />
      <ActionPanel.Section title="Claude">
        <Action title="Send (Enter)" icon={Icon.ArrowUpCircle} shortcut={{ modifiers: ["cmd", "shift"], key: "return" }} onAction={press("Enter")} />
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={run((p) => newline(p))} />
        <Action title="Paste Screenshot" icon={Icon.Image} shortcut={{ modifiers: ["ctrl"], key: "v" }} onAction={pasteImage} />
        <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={press("Escape")} />
        <Action title="Tab" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} onAction={press("Tab")} />
        <Action title="Cycle Mode" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={press("BTab")} />
        <Action title="Clear Claude's Input" icon={Icon.Trash} shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }} onAction={press("C-u")} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Session">
        <Action.Push title="Read Full Width" icon={Icon.Maximize} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }} target={<Detail navigationTitle={a.name} markdown={conversationMarkdown(turns, 60)} />} />
        <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={() => openInGhostty(a)} />
        <Action.CopyToClipboard title="Copy Session ID" content={a.sessionId} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
      </ActionPanel.Section>
    </ActionPanel>
  );

  const selectedId = menu ? `m:${Math.max(0, hiRef.current)}` : selected;

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
      navigationTitle={`${a.name} · ${needs ? "needs you" : STATE[a.state].label} · ${short(a.cwd)}`}
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
          {newestFirst.length ? (
            newestFirst.slice(0, 40).map((t, i) => (
              <List.Item
                key={t.id}
                id={"t:" + t.id}
                title={t.prompt.trim().split("\n")[0] || "(image)"}
                icon={i === 0 ? Icon.Message : Icon.Clock}
                detail={detail}
                actions={actions({ title: needs ? "Answer (Enter)" : "Send (Enter)", icon: Icon.ArrowUpCircle, onAction: press("Enter") })}
              />
            ))
          ) : (
            <List.Item id="t:none" title="…" detail={detail} actions={actions({ title: "Send (Enter)", icon: Icon.ArrowUpCircle, onAction: press("Enter") })} />
          )}
        </List.Section>
      )}
    </List>
  );
}

/** Same composer picture? (Rows, cursor and question flag; the transcript offset isn't part of it.) */
function sameBottom(a: Poll, b: Poll): boolean {
  return a.needs === b.needs && a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y && a.bottom.length === b.bottom.length && a.bottom.every((l, i) => l === b.bottom[i]);
}
