

// "Claude Terminal": Claude Code on the Spark in a Raycast popover, as text, shaped like the TUI's
// agents view. This is the sessions list (full width): "New session", then every session from
// `claude agents` with the summary line and PRs the agents view shows (~/.claude/jobs/<id>/state.json).
// Type a task and press Enter to dispatch a new background session; Enter on a session opens it,
// full width (session.tsx).

import { Action, ActionPanel, Color, Icon, Keyboard, LaunchProps, List, LocalStorage, showToast, Toast, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Session, openInGhostty } from "./session";
import { Agent, AgentState, listAgents, startAgent, stopAgent } from "./term-backend";
import { listRepos, prefs, repoPath } from "./spark";

const LIST_POLL_MS = 3000;
const NEW_DIR = "newSessionDir";

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
