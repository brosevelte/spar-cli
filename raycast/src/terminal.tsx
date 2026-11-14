// "Claude Terminal": Claude Code on the Spark in a Raycast popover, shaped like the TUI's agents view.
//
//   Sessions (full width)     -- every session from `claude agents`, with its real state. Type a task
//                                and press Enter to dispatch a new background session, as in the
//                                agents view; Enter on a session opens it.
//   Conversation (full width) -- the session's real transcript drawn terminal-style (term-transcript.ts
//                                -> term-render.ts SVG), pinned to the newest message, with the live
//                                bottom of the TUI underneath: its composer, @ / slash menus, and any
//                                question Claude is asking. A one-column Grid holds the image, so it
//                                spans the window and keeps a search bar.
//
// The search bar is mirrored into the session's composer as you type (term-backend.ts: a pane in
// Raycast's own tmux session runs `claude attach <id>`). The composer is shared with anyone else
// attached -- Ghostty's agents view shows the same draft -- and it lives on the box, so a half-written
// message survives closing Raycast. Everything other than typing and Enter lives in ⌘K.

import {
  Action,
  ActionPanel,
  Color,
  Grid,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  LocalStorage,
  closeMainWindow,
  environment,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { candidates } from "./chat-mention";
import { attachFromClipboard, safeUnlink } from "./clipboard";
import { Agent, AgentState, COLS, Poll, ensureAttached, keys, listAgents, listFiles, newline, paste, poll, retype, startAgent, stopAgent, upload } from "./term-backend";
import { screenSvg } from "./term-render";
import { Transcript, conversationLines } from "./term-transcript";
import { focusGhostty, listRepos, prefs, q, repoPath, tmux } from "./spark";

const LIST_POLL_MS = 3000;
const POLL_MS = 900;
const NEW_DIR = "newSessionDir";
const MENTION_AT_END = /(?:^|\s)@([^\s]*)$/;
// The image is 4:3 at COLS columns: this many terminal rows fit (term-render's 14px font, 18px rows).
const SCREEN_ROWS = 30;
const MAX_BOTTOM = 16;

export const STATE: Record<AgentState, { label: string; color: Color; icon: Icon }> = {
  needs: { label: "needs you", color: Color.Orange, icon: Icon.QuestionMarkCircle },
  working: { label: "working", color: Color.Green, icon: Icon.CircleProgress },
  done: { label: "done", color: Color.SecondaryText, icon: Icon.CheckCircle },
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

  const open = useCallback((a: Agent) => push(<Conversation agent={a} onClose={agents.revalidate} />), []);

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
      const a = list.find((x) => x.id === id) ?? { id, sessionId: "", name: text.slice(0, 40), cwd: dir, startedAt: Date.now(), state: "working" as AgentState, raw: "" };
      agents.revalidate();
      open(a);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't start the session";
      toast.message = String(e);
    }
  }

  const all = agents.data ?? [];
  const groups: [AgentState, Agent[]][] = [
    ["needs", all.filter((a) => a.state === "needs")],
    ["working", all.filter((a) => a.state === "working")],
    ["done", all.filter((a) => a.state === "done").slice(0, 30)],
  ];
  const dirs = [...new Set([prefs.chatDefaultDir || prefs.srcDir, "~", ...(repos.data ?? []).map(repoPath)])];
  const startAction = task.trim() ? <Action title="Start New Session" icon={Icon.PlusCircle} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={dispatch} /> : null;

  return (
    <List
      isLoading={agents.isLoading && !agents.data}
      filtering={false}
      searchText={task}
      onSearchTextChange={setTask}
      searchBarPlaceholder="Describe a task for a new session… (Enter starts it)"
      selectedItemId={task.trim() ? "new" : undefined}
      navigationTitle="Claude on the Spark"
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
      {task.trim() && (
        <List.Item
          id="new"
          title={task.trim()}
          subtitle={`new session in ${short(dir ?? "")}`}
          icon={{ source: Icon.PlusCircle, tintColor: Color.Blue }}
          actions={
            <ActionPanel>
              <Action title="Start New Session" icon={Icon.PlusCircle} onAction={dispatch} />
            </ActionPanel>
          }
        />
      )}
      {groups.map(([state, list]) =>
        list.length ? (
          <List.Section key={state} title={STATE[state].label} subtitle={String(list.length)}>
            {list.map((a) => (
              <List.Item
                key={a.id}
                id={a.id}
                title={a.name}
                subtitle={short(a.cwd)}
                icon={{ source: STATE[a.state].icon, tintColor: STATE[a.state].color }}
                accessories={[{ text: age(a.startedAt), tooltip: a.raw }]}
                actions={
                  <ActionPanel>
                    <Action title="Open" icon={Icon.Message} onAction={() => open(a)} />
                    {startAction}
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
        ) : null,
      )}
      {agents.data && !all.length && !task && <List.EmptyView icon={Icon.Message} title="No sessions yet" description="Type a task above and press Enter to start one." />}
    </List>
  );
}

// ---------------------------------------------------------------------------- a conversation

const SCREENS = path.join(environment.supportPath, "screens");

function Conversation(props: { agent: Agent; onClose: () => void }) {
  const a = props.agent;
  const [text, setText] = useState("");
  const [pane, setPane] = useState<string>();
  const [last, setLast] = useState<Poll>();
  const [turnsVersion, setTurnsVersion] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  const transcript = useRef(new Transcript());
  const offset = useRef(0);
  const sessionId = useRef(a.sessionId);
  const desired = useRef("");
  const mirrored = useRef("");
  const syncing = useRef<Promise<void> | null>(null);
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
      setLast(p);
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

  // ---- render: the conversation pinned to the bottom, the live TUI rows under it
  const header = `${a.name} · ${last?.needs ? "needs you" : STATE[a.state].label} · ${short(a.cwd)}${scroll ? ` · scrolled ${scroll} — ⌥↓` : ""}`;
  useEffect(() => {
    const bottom = (last?.bottom ?? []).slice(-MAX_BOTTOM);
    const convoRows = SCREEN_ROWS - bottom.length;
    const all = conversationLines(transcript.current.turns, COLS);
    const end = Math.max(0, all.length - scroll);
    const shown = all.slice(Math.max(0, end - convoRows), end);
    const lines = [...Array(Math.max(0, convoRows - shown.length)).fill(""), ...shown, ...bottom];
    const cursor = last?.cursor && !scroll ? { x: last.cursor.x, y: convoRows + last.cursor.y } : undefined;
    const svg = screenSvg({ lines, cols: COLS, cursor }, header);
    const file = path.join(SCREENS, `${a.id}-${createHash("sha1").update(svg).digest("hex").slice(0, 12)}.svg`);
    const previous = imageRef.current;
    if (file === previous) return;
    writeFileSync(file, svg);
    setImage(file);
    // Raycast caches images by path, so each frame is a new file; the old one goes once replaced.
    if (previous) setTimeout(() => safeUnlink(previous), 3000);
  }, [turnsVersion, last, scroll]);

  // ---- typing: the search bar mirrored into the composer
  const sync = useCallback((): Promise<void> => {
    if (syncing.current) return syncing.current;
    const run = (async () => {
      try {
        while (paneRef.current && mirrored.current !== desired.current) {
          const want = desired.current;
          const have = [...mirrored.current];
          const next = [...want];
          let i = 0;
          while (i < have.length && i < next.length && have[i] === next[i]) i++;
          await retype(paneRef.current, have.length - i, next.slice(i).join(""));
          mirrored.current = want;
        }
      } catch (e) {
        showToast({ style: Toast.Style.Failure, title: "Couldn't type into Claude", message: String(e) });
        mirrored.current = desired.current;
      } finally {
        syncing.current = null;
      }
      tick();
    })();
    syncing.current = run;
    return run;
  }, []);

  function onText(t: string) {
    setText(t);
    desired.current = t;
    sync();
  }
  const commit = () => {
    setText("");
    desired.current = "";
    mirrored.current = "";
  };
  const act = (fn: (pane: string) => Promise<void>) => async () => {
    const p = paneRef.current;
    if (!p) {
      showToast({ style: Toast.Style.Failure, title: "Not attached yet" });
      return;
    }
    try {
      await sync();
      await fn(p);
    } catch (e) {
      showToast({ style: Toast.Style.Failure, title: "Failed", message: String(e) });
    }
    tick();
  };
  const send = act(async (p) => {
    await keys(p, "Enter");
    commit();
  });
  const addLine = act(async (p) => {
    await newline(p);
    commit();
  });
  const press = (...k: string[]) => act((p) => keys(p, ...k));
  const pasteImage = act(async (p) => {
    const at = await attachFromClipboard();
    try {
      const remote = await upload(readFileSync(at.path), at.path.split("/").pop()!);
      await paste(p, ` ${remote} `);
      commit();
      showToast({ style: Toast.Style.Success, title: "Image attached" });
    } finally {
      safeUnlink(at.path);
    }
  });

  // ---- @ picker
  const files = useCachedPromise(listFiles, [a.cwd], { keepPreviousData: true });
  const mention = MENTION_AT_END.exec(text);
  const mentionQuery = mention ? mention[1] : undefined;
  const picks = useMemo(
    () => (mentionQuery === undefined || !files.data ? [] : candidates([...files.data.dirs, ...files.data.files], mentionQuery, 60)),
    [mentionQuery, files.data],
  );
  const insert = (p: string) => {
    const m = MENTION_AT_END.exec(text);
    if (m) onText(text.slice(0, text.length - m[1].length - 1) + "@" + p + (p.endsWith("/") ? "" : " "));
  };

  const keyActions = (
    <>
      <ActionPanel.Section title="Message">
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={addLine} />
        <Action title="Paste Image" icon={Icon.Image} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={pasteImage} />
        <Action title="Backspace in Claude" icon={Icon.ArrowLeft} shortcut={{ modifiers: ["opt"], key: "backspace" }} onAction={press("BSpace")} />
        <Action
          title="Clear Claude's Input"
          icon={Icon.Trash}
          shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
          onAction={act(async (p) => {
            await keys(p, "C-u");
            commit();
          })}
        />
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
        <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={() => openInGhostty(a)} />
      </ActionPanel.Section>
    </>
  );

  if (mentionQuery !== undefined && picks.length) {
    return (
      <List searchText={text} onSearchTextChange={onText} filtering={false} throttle={false} navigationTitle={header} searchBarPlaceholder="@ file">
        <List.Section title={`@ ${short(a.cwd)}`}>
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
      searchText={text}
      onSearchTextChange={onText}
      navigationTitle={header}
      searchBarPlaceholder={last?.needs ? "Claude is asking — Enter or ⌘1 yes · ⌘3 no" : "Message Claude — @ files, / commands, ⌘↵ newline, ⌘K more"}
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
