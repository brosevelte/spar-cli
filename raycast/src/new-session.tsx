import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { focusGhostty, prefs, q, tmux } from "./spark";
import { Refused, paneTarget, toAgentsList } from "./agentview";

// Every session goes through pane 1's agent view (ruling 2026-10-30). This only takes you there: the
// Spark tab, pane 1, back on the agents list with an empty "describe a task for a new session" prompt.
// It never types or presses Enter -- you write the task in the real prompt, where @-completion works,
// and dispatch it yourself. Sessions start in the agent view's directory (~/src/ultron-framework).
export default async function Command() {
  await closeMainWindow({ clearRootSearch: true });
  await tmux(`select-window -t ${q(`${prefs.session}:${prefs.window}`)}`, `select-pane -t ${paneTarget()}`);
  const [ready, focused] = await Promise.allSettled([toAgentsList(), focusGhostty()]);
  if (ready.status === "rejected") {
    const e = ready.reason;
    await showToast({
      style: Toast.Style.Failure,
      title: "Couldn't reach the new-task prompt",
      message: e instanceof Refused ? e.message : String(e),
    });
    return;
  }
  if (focused.status === "rejected") {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't focus the Spark tab", message: String(focused.reason) });
    return;
  }
  await showHUD("New session: type the task in pane 1");
}
