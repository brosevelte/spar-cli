// "Claude Terminal": the real Claude Code TUI on the Spark, in a Raycast popover.
//
// Claude runs where it always does -- a tmux pane on the box -- and this command is a window onto
// it, laid out like PromptCast (WerrySs, raycast/extensions extensions/codex-claude-cli, MIT): actions
// on the left, the live terminal on the right (term-render.ts draws the pane as an SVG), the search
// bar on top as the keyboard.
//
// The search bar is MIRRORED into the TUI's composer on every keystroke (backspace over what
// changed, type the rest), so Claude's own @ menu, slash commands and multi-line input show up in the
// render as you type. Enter sends Enter. Because the composer lives in tmux, a half-written message
// survives closing Raycast: reopen, and keep typing where it left off. Nothing is reimplemented --
// approvals are Claude's own prompt (Enter, or ⌘1–⌘3 to pick an option), drafts are its composer.
//
// Extras on top of the TUI:
//   @ picker  -- while the bar ends in `@<partial>`, the left side lists the repo's files; Enter
//               completes the path (a directory keeps completing inside it).
//   images    -- ⌘⇧V uploads the clipboard image to ~/clipboard on the box and pastes its path the
//               way a terminal paste would, which Claude turns into an image attachment.
//   ⌘↵        -- a newline in the composer (backslash-Enter) for long multi-line messages.

import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  LocalStorage,
  closeMainWindow,
  confirmAlert,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { candidates } from "./chat-mention";
import { attachFromClipboard, safeUnlink } from "./clipboard";
import { Pane, PaneState, Snapshot, keys, killSession, listFiles, listPanes, newSession, newline, paste, retype, snapshot, upload } from "./term-backend";
import { screenMarkdown } from "./term-render";
import { focusGhostty, listRepos, prefs, q, repoPath, tmux } from "./spark";

const POLL_MS = 700;
const LAST = "lastPane";
const MENTION_AT_END = /(?:^|\s)@([^\s]*)$/;

const STATE: Record<PaneState, { label: string; color: Color; icon: Icon }> = {
  waiting: { label: "needs you", color: Color.Orange, icon: Icon.QuestionMarkCircle },
  working: { label: "working", color: Color.Green, icon: Icon.CircleProgress },
  idle: { label: "idle", color: Color.SecondaryText, icon: Icon.Terminal },
};

const short = (p: string) => p.replace(new RegExp(`^/home/[^/]+`), "~");

// ---------------------------------------------------------------------------- home: pick a session

export default function Command(props: LaunchProps<{ launchContext?: { paneId?: string } }>) {
  const { push } = useNavigation();
  const panes = useCachedPromise(listPanes, [], { keepPreviousData: true });
  const repos = useCachedPromise(listRepos, [], { keepPreviousData: true });
  const opened = useRef(false);

  const openPane = useCallback((p: Pick<Pane, "id" | "session" | "cwd">) => {
    LocalStorage.setItem(LAST, p.id);
    push(<TerminalView paneId={p.id} session={p.session} cwd={p.cwd} onExit={panes.revalidate} />);
  }, []);

  // Straight back into the session you were using (or the one the menu bar asked for).
  useEffect(() => {
    if (opened.current || !panes.data) return;
    opened.current = true;
    (async () => {
      const want = props.launchContext?.paneId ?? (await LocalStorage.getItem<string>(LAST));
      const p = panes.data!.find((x) => x.id === want);
      if (p) openPane(p);
    })();
  }, [panes.data]);

  async function start(dir: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Starting Claude in ${dir}` });
    try {
      const id = await newSession(dir);
      toast.hide();
      openPane({ id, session: "", cwd: dir });
      panes.revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't start Claude";
      toast.message = String(e);
    }
  }

  const dirs = [prefs.chatDefaultDir || prefs.srcDir, "~"];
  return (
    <List isLoading={panes.isLoading} searchBarPlaceholder="Claude sessions on the Spark…" navigationTitle="Claude Terminal">
      <List.Section title="Live" subtitle={panes.data ? String(panes.data.length) : undefined}>
        {(panes.data ?? []).map((p) => (
          <List.Item
            key={p.id}
            title={p.session.startsWith("rc-") ? p.session.slice(3) : `${p.session} · ${p.window}`}
            subtitle={short(p.cwd)}
            icon={{ source: STATE[p.state].icon, tintColor: STATE[p.state].color }}
            accessories={[{ tag: { value: STATE[p.state].label, color: STATE[p.state].color } }]}
            actions={
              <ActionPanel>
                <Action title="Open" icon={Icon.Terminal} onAction={() => openPane(p)} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={panes.revalidate} />
                {p.session.startsWith("rc-") && (
                  <Action
                    title="End Session"
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    shortcut={Keyboard.Shortcut.Common.Remove}
                    onAction={async () => {
                      if (await confirmAlert({ title: `End ${p.session}?`, message: "Kills the tmux session and the Claude in it. The conversation stays resumable.", primaryAction: { title: "End", style: Alert.ActionStyle.Destructive } })) {
                        await killSession(p.session);
                        panes.revalidate();
                      }
                    }}
                  />
                )}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="New Claude session in…">
        {[...dirs, ...(repos.data ?? []).map(repoPath)].map((d) => (
          <List.Item key={d} title={short(d)} icon={Icon.PlusCircle} actions={<ActionPanel><Action title="Start Claude Here" icon={Icon.Play} onAction={() => start(d)} /></ActionPanel>} />
        ))}
      </List.Section>
    </List>
  );
}

// ---------------------------------------------------------------------------- the terminal

function TerminalView(props: { paneId: string; session: string; cwd: string; onExit: () => void }) {
  const id = props.paneId;
  const [text, setText] = useState("");
  const [shot, setShot] = useState<Snapshot>();
  const [scroll, setScroll] = useState(0);
  const [error, setError] = useState<string>();
  const desired = useRef("");
  const mirrored = useRef("");
  const syncing = useRef<Promise<void> | null>(null);
  const scrollRef = useRef(0);
  scrollRef.current = scroll;

  const refresh = useCallback(() => {
    snapshot(id, scrollRef.current)
      .then((s) => {
        setShot(s);
        setError(undefined);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(t);
      props.onExit();
    };
  }, []);
  useEffect(refresh, [scroll]);

  // Bring the composer in line with the bar: one call per burst, however fast you type.
  const sync = useCallback((): Promise<void> => {
    if (syncing.current) return syncing.current;
    const run = (async () => {
      try {
        while (mirrored.current !== desired.current) {
          const want = desired.current;
          const have = [...mirrored.current];
          const next = [...want];
          let p = 0;
          while (p < have.length && p < next.length && have[p] === next[p]) p++;
          await retype(id, have.length - p, next.slice(p).join(""));
          mirrored.current = want;
        }
      } catch (e) {
        showToast({ style: Toast.Style.Failure, title: "Couldn't type into Claude", message: String(e) });
        mirrored.current = desired.current; // don't loop on a dead link
      } finally {
        syncing.current = null;
      }
      refresh();
    })();
    syncing.current = run;
    return run;
  }, []);

  function onText(t: string) {
    setText(t);
    desired.current = t;
    sync();
  }

  /** The bar's text is now part of the composer (sent, or a line committed): start a fresh mirror. */
  const commit = () => {
    setText("");
    desired.current = "";
    mirrored.current = "";
  };

  const act = (fn: () => Promise<void>) => async () => {
    try {
      await sync();
      await fn();
    } catch (e) {
      showToast({ style: Toast.Style.Failure, title: "Failed", message: String(e) });
    }
    refresh();
  };

  const send = act(async () => {
    await keys(id, "Enter");
    commit();
  });
  const addLine = act(async () => {
    await newline(id);
    commit();
  });
  const press = (...k: string[]) => act(() => keys(id, ...k));
  const image = act(async () => {
    const a = await attachFromClipboard();
    try {
      const remote = await upload(readFileSync(a.path), a.path.split("/").pop()!);
      await paste(id, ` ${remote} `);
      commit();
      showToast({ style: Toast.Style.Success, title: "Image attached", message: remote });
    } finally {
      safeUnlink(a.path);
    }
  });
  const openInGhostty = act(async () => {
    await closeMainWindow({ clearRootSearch: true });
    if (props.session === prefs.session) {
      await tmux(`select-window -t ${q(id)}`, `select-pane -t ${q(id)}`);
      await focusGhostty();
    } else {
      const spark = `${homedir()}/.local/bin/spark`;
      const session = props.session || (await snapshotSession(id));
      // A new Ghostty window attached to this session over mosh, like `spark mosh <session>` by hand.
      spawn("/usr/bin/open", ["-na", "Ghostty", "--args", "-e", spark, "mosh", "--no-layout", session], { detached: true, stdio: "ignore" }).unref();
    }
  });

  // ---- @ picker
  const files = useCachedPromise(listFiles, [props.cwd], { keepPreviousData: true });
  const mention = MENTION_AT_END.exec(text);
  const mentionQuery = mention ? mention[1] : undefined;
  const picks = useMemo(() => (mentionQuery === undefined || !files.data ? [] : candidates([...files.data.dirs, ...files.data.files], mentionQuery, 60)), [mentionQuery, files.data]);
  const insert = (p: string) => {
    const m = MENTION_AT_END.exec(text);
    if (!m) return;
    onText(text.slice(0, text.length - m[1].length - 1) + "@" + p + (p.endsWith("/") ? "" : " "));
  };

  // ---- the screen
  const state = shot ? STATE[shot.state] : undefined;
  const header = [props.session ? props.session.replace(/^rc-/, "") : id, short(props.cwd), state?.label, shot?.scrolled ? `scrolled ${shot.scrolled} lines — ⌥↓ to return` : undefined]
    .filter(Boolean)
    .join(" · ");
  const markdown = error ? `**Can't read the pane**\n\n\`\`\`\n${error}\n\`\`\`` : shot ? screenMarkdown(shot, header) : "";
  const detail = <List.Item.Detail markdown={markdown} />;

  const common = (
    <>
      <ActionPanel.Section title="Claude">
        <Action title="Newline" icon={Icon.Text} shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={addLine} />
        <Action title="Paste Image" icon={Icon.Image} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={image} />
        <Action title="Option 1 (Yes)" icon={Icon.CheckCircle} shortcut={{ modifiers: ["cmd"], key: "1" }} onAction={press("1")} />
        <Action title="Option 2" icon={Icon.Circle} shortcut={{ modifiers: ["cmd"], key: "2" }} onAction={press("2")} />
        <Action title="Option 3 (No)" icon={Icon.XMarkCircle} shortcut={{ modifiers: ["cmd"], key: "3" }} onAction={press("3")} />
        <Action title="Up" icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowUp" }} onAction={press("Up")} />
        <Action title="Down" icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }} onAction={press("Down")} />
        <Action title="Tab" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} onAction={press("Tab")} />
        <Action title="Escape / Interrupt" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={press("Escape")} />
        <Action title="Cycle Mode (Shift-Tab)" icon={Icon.Switch} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }} onAction={press("BTab")} />
        <Action title="Backspace in Claude" icon={Icon.ArrowLeft} shortcut={{ modifiers: ["opt"], key: "backspace" }} onAction={press("BSpace")} />
        <Action title="Clear Claude's Input" icon={Icon.Trash} shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }} onAction={act(async () => (await keys(id, "C-u"), commit()))} />
      </ActionPanel.Section>
      <ActionPanel.Section title="View">
        <Action title="Scroll Up" icon={Icon.ChevronUp} shortcut={{ modifiers: ["opt"], key: "arrowUp" }} onAction={() => setScroll((s) => s + 15)} />
        <Action title="Scroll Down" icon={Icon.ChevronDown} shortcut={{ modifiers: ["opt"], key: "arrowDown" }} onAction={() => setScroll((s) => Math.max(0, s - 15))} />
        <Action.Push title="Full Width" icon={Icon.Maximize} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }} target={<FullView paneId={id} header={header} />} />
        <Action title="Open in Ghostty" icon={Icon.Window} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={openInGhostty} />
      </ActionPanel.Section>
    </>
  );

  const item = (key: string, title: string, icon: Icon, onAction: () => void, accessory?: string) => (
    <List.Item
      key={key}
      id={key}
      title={title}
      icon={icon}
      accessories={accessory ? [{ text: accessory }] : undefined}
      detail={detail}
      actions={
        <ActionPanel>
          <Action title={title} icon={icon} onAction={onAction} />
          {common}
        </ActionPanel>
      }
    />
  );

  return (
    <List
      searchText={text}
      onSearchTextChange={onText}
      filtering={false}
      throttle={false}
      isShowingDetail
      searchBarPlaceholder={shot?.state === "waiting" ? "Claude needs you: Enter / ⌘1 yes · ⌘3 no" : "Type to Claude — @ files, / commands, ⌘↵ newline"}
      navigationTitle={header}
    >
      {mentionQuery !== undefined && picks.length > 0 ? (
        <List.Section title={`@ ${short(props.cwd)}`}>
          {picks.map((p) => (
            <List.Item
              key={p}
              id={"f:" + p}
              title={p}
              icon={p.endsWith("/") ? Icon.Folder : Icon.Document}
              detail={detail}
              actions={
                <ActionPanel>
                  <Action title="Insert" icon={Icon.Plus} onAction={() => insert(p)} />
                  <Action title="Send" icon={Icon.ArrowUpCircle} shortcut={{ modifiers: ["cmd", "shift"], key: "return" }} onAction={send} />
                  {common}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : (
        <List.Section title={header}>
          {item("send", shot?.state === "waiting" ? "Answer (Enter)" : "Send", Icon.ArrowUpCircle, send, "↵")}
          {item("newline", "Newline", Icon.Text, addLine, "⌘↵")}
          {item("image", "Image", Icon.Image, image, "⌘⇧V")}
          {item("yes", "Option 1 (Yes)", Icon.CheckCircle, press("1"), "⌘1")}
          {item("no", "Option 3 (No)", Icon.XMarkCircle, press("3"), "⌘3")}
          {item("esc", "Escape / Interrupt", Icon.Stop, press("Escape"), "⌘.")}
          {item("mode", "Cycle Mode", Icon.Switch, press("BTab"), "⌘⇧M")}
          {item("ghostty", "Open in Ghostty", Icon.Window, openInGhostty, "⌘⇧O")}
        </List.Section>
      )}
    </List>
  );
}

async function snapshotSession(id: string): Promise<string> {
  return (await tmux(`display -p -t ${q(id)} '#{session_name}'`)).trim();
}

/** Read-only, full window width: the same screen, bigger. Esc goes back to typing. */
function FullView(props: { paneId: string; header: string }) {
  const [md, setMd] = useState("");
  useEffect(() => {
    const tick = () =>
      snapshot(props.paneId)
        .then((s) => setMd(screenMarkdown(s, props.header)))
        .catch((e) => setMd(String(e)));
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, []);
  return <Detail markdown={md} navigationTitle={props.header} />;
}
