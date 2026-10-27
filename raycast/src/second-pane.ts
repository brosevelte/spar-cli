import { action, focusGhostty, pane, prefs, q, tmux } from "./spark";

export default async function Command() {
  await action("Shell pane", async () => {
    await tmux(`select-window -t ${q(`${prefs.session}:${prefs.window}`)}`, `select-pane -t ${q(pane(2))}`);
    await focusGhostty();
  });
}
