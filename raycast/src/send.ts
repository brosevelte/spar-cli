import { LaunchProps } from "@raycast/api";
import { action, focusGhostty, pane, prefs, q, tmux } from "./spark";

// `-l` types the text literally (no key-name expansion), then a separate Enter submits it. The short
// pause lets Claude Code's input finish absorbing what it sees as a paste before the Enter lands.
export default async function Command(props: LaunchProps<{ arguments: { message: string } }>) {
  const message = props.arguments.message.trim();
  await action("Sent to Claude", async () => {
    const t = q(pane(1));
    await tmux(
      `select-window -t ${q(`${prefs.session}:${prefs.window}`)}`,
      `select-pane -t ${t}`,
      `send-keys -t ${t} -l -- ${q(message)}`,
      `sleep 0.15`,
      `send-keys -t ${t} Enter`,
    );
    await focusGhostty();
  });
}
