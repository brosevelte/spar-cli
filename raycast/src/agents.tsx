import { Action, ActionPanel, Color, Icon, List, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { focusGhostty, newWindow, pane, prefs, q, ssh, tmux } from "./spark";

interface Agent {
  id: string;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  state: string;
}

async function loadAgents(): Promise<Agent[]> {
  const out = await ssh("claude agents --json --all");
  const agents = JSON.parse(out) as Agent[];
  return agents.sort((a, b) => b.startedAt - a.startedAt);
}

const STATE_COLOR: Record<string, Color> = {
  running: Color.Green,
  working: Color.Green,
  waiting: Color.Orange,
  needs_input: Color.Orange,
  done: Color.SecondaryText,
  failed: Color.Red,
};

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function openAgent(a: Agent) {
  try {
    await closeMainWindow({ clearRootSearch: true });
    // Resume the job's session in its own window so the main Claude pane is left alone.
    await newWindow(a.id, a.cwd, `claude --resume ${a.sessionId}`);
    await focusGhostty();
    await showHUD(`Opened ${a.name}`);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "Open failed", message: String(e) });
  }
}

async function openAgentsPage() {
  await closeMainWindow({ clearRootSearch: true });
  const t = q(pane(1));
  await tmux(`select-window -t ${q(`${prefs.session}:${prefs.window}`)}`, `select-pane -t ${t}`, `send-keys -t ${t} ${q(prefs.agentsKey)}`);
  await focusGhostty();
}

export default function Command() {
  const { data, isLoading, revalidate } = useCachedPromise(loadAgents, [], { keepPreviousData: true });
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search agents on the Spark…">
      {(data ?? []).map((a) => (
        <List.Item
          key={a.id}
          title={a.name || a.id}
          subtitle={a.cwd.split("/").pop()}
          accessories={[
            { tag: { value: a.state, color: STATE_COLOR[a.state] ?? Color.SecondaryText } },
            { text: ago(a.startedAt), tooltip: new Date(a.startedAt).toLocaleString() },
          ]}
          actions={
            <ActionPanel>
              <Action title="Open in New Tmux Window" icon={Icon.Terminal} onAction={() => openAgent(a)} />
              <Action title="Open Agents Page in Claude" icon={Icon.List} onAction={openAgentsPage} />
              <Action.CopyToClipboard title="Copy Session ID" content={a.sessionId} />
              <Action.CopyToClipboard title="Copy Resume Command" content={`claude --resume ${a.sessionId}`} />
              <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
