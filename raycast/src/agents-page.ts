import { action, focusGhostty, pane, prefs, q, tmux } from "./spark";

// Claude Code opens its agents view on a key press while the prompt is empty ("↓ to manage").
export default async function Command() {
  await action("Agents", async () => {
    const t = q(pane(1));
    await tmux(
      `select-window -t ${q(`${prefs.session}:${prefs.window}`)}`,
      `select-pane -t ${t}`,
      `send-keys -t ${t} ${q(prefs.agentsKey)}`,
    );
    await focusGhostty();
  });
}
