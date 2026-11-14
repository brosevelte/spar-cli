// "Claude Terminal": Claude Code on the Spark in a Raycast popover, shaped like the TUI's agents view.
//
//   Sessions (full width)     -- every session from `claude agents`, with its real state. Type a task
//                                and press Enter to dispatch a new background session, as in the
//                                agents view; Enter on a session opens it.
//   Conversation (full width) -- the session's real transcript drawn terminal-style (term-transcript.ts
//                                -> term-render.ts SVG), pinned to the newest message, with the live
//                                bottom of the TUI underneath: its composer, @ / slash menus, and any
//                                question Claude is asking. A one-column Grid holds the image, so it
//                                spans the window (conversation.tsx).
//
// In a conversation the search bar is only a keyboard: each keystroke goes straight into the
// session's composer and shows up in the image. The composer is shared with anyone else attached --
// Ghostty's agents view shows the same draft -- and lives on the box, so a half-written message
// survives closing Raycast. Everything other than typing and Enter lives in ⌘K.

import { Action, ActionPanel, Color, Icon, Keyboard, LaunchProps, List, LocalStorage, closeMainWindow, showToast, Toast, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation } from "./conversation";
import { Agent, AgentState, listAgents, startAgent, stopAgent } from "./term-backend";
import { focusGhostty, listRepos, prefs, q, repoPath, tmux } from "./spark";

const LIST_POLL_MS = 3000;
const NEW_DIR = "newSessionDir";

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

  const open = useCallback(
    (a: Agent) => push(<Conversation agent={a} stateLabel={STATE[a.state].label} onClose={agents.revalidate} openInGhostty={() => openInGhostty(a)} />),
    [],
  );

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
