// Driving Claude Code's agent view in pane 1 by keystrokes. A keystroke in the wrong mode is not
// harmless: text + Enter in the new-task prompt DISPATCHES A NEW SESSION, and Esc with no find open
// QUITS the view. So every step re-reads the pane and refuses (sending nothing more) the moment it
// doesn't look exactly as expected. Never add a blind Escape/Enter.

import { pane, q, tmux } from "./spark";

export const PROMPT_EMPTY = "describe a task for a new session";
export const FIND_MARK = "⌕";

export class Refused extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const paneTarget = () => q(pane(1));
export const capture = () => tmux(`capture-pane -p -t ${paneTarget()}`);

/** Re-read pane 1 every 80ms (one ~40ms round trip each) until `ok` holds; returns the last screen either way. */
export async function settle(ok: (screen: string) => boolean, timeoutMs = 1500): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const screen = await capture();
    if (ok(screen) || Date.now() >= until) return screen;
    await sleep(80);
  }
}

export const findOpen = (sc: string) => sc.includes(FIND_MARK) && sc.includes("esc to clear");

/**
 * Bring pane 1 to "agents list, empty prompt, no find" from whatever it shows, one verified key at a
 * time (at most 3 steps). Only two keys, each only where proven harmless: Esc while the footer says
 * "esc to clear" (a find is open -- the agent view also restores its last find on startup), and Left
 * from inside a session whose prompt is empty ("← N agents"). Anything else refuses.
 */
export async function toAgentsList(): Promise<void> {
  const t = paneTarget();
  let screen = await capture();
  for (let step = 0; findOpen(screen) || !screen.includes(PROMPT_EMPTY); step++) {
    if (step >= 3) throw new Refused("couldn't bring pane 1 back to the agents list");
    if (findOpen(screen)) {
      await tmux(`send-keys -t ${t} Escape`);
      screen = await settle((sc) => !findOpen(sc));
    } else if (/←\s*\d*\s*agents?/.test(screen) && screen.split("\n").some((l) => /^❯\s*$/.test(l))) {
      await tmux(`send-keys -t ${t} Left`);
      // Back on the list, possibly with the agent view's restored find open (the next pass clears it).
      screen = await settle((sc) => sc.includes(PROMPT_EMPTY) || findOpen(sc));
    } else {
      throw new Refused("pane 1 is neither the agents list nor a session with an empty prompt");
    }
  }
}
