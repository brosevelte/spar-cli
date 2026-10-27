import { action, focusGhostty, pane, prefs, q, tmux } from "./spark";

export default async function Command() {
  await action("Claude", async () => {
    await tmux(`select-window -t ${q(`${prefs.session}:${prefs.window}`)}`, `select-pane -t ${q(pane(1))}`);
    await focusGhostty();
  });
}
