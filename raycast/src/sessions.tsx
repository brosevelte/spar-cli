import { Action, ActionPanel, Clipboard, Color, Icon, List, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { execFile } from "node:child_process";
import { useState } from "react";
import { promisify } from "node:util";
import { focusGhostty, pane, prefs, q, ssh, tmux } from "./spark";

const run = promisify(execFile);

// Past Claude Code sessions from BOTH machines, via atuin's thread capture (synced through the
// self-hosted atuin server on the Spark), searched locally on this Mac -- no ssh for the search.
//
// Picking one opens it in pane 1's agent view ONLY when the agent view can: it lists the Spark's
// background sessions, and its Ctrl+F find matches names (not ids). Anything else -- Mac sessions,
// plain `claude` sessions -- just copies `atuin resume <id>`; this command never opens windows or
// touches the layout for those (ruling 2026-10-30).
//
// The agent view is driven by keystrokes, and a keystroke in the wrong mode is not harmless: text +
// Enter in the new-task prompt DISPATCHES A NEW SESSION, and Esc with no find active QUITS the view.
// So every step re-reads the pane and stops (sending nothing more) the moment it doesn't look exactly
// as expected. Never add a blind Escape/Enter here.

interface Thread {
  atuin_id: string;
  session_id: string;
  cwd: string;
  git_branch: string | null;
  updated_at: string;
  message_count: number;
  title: string | null;
}

interface Agent {
  id: string;
  sessionId: string;
  name: string;
  state: string;
}

const PROMPT_EMPTY = "describe a task for a new session";
const FIND_MARK = "⌕";

async function atuin(args: string[]): Promise<string> {
  const { stdout } = await run(prefs.atuinPath, args, {
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ATUIN_SESSION: process.env.ATUIN_SESSION ?? "raycast" },
  });
  return stdout;
}

async function loadThreads(text: string): Promise<Thread[]> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return (JSON.parse(await atuin(["threads", "list", "--style", "json"])) as Thread[]).slice(0, 100);
  }
  const hits = JSON.parse(await atuin(["threads", "search", "--style", "json", "--limit", "40", "--", ...words])) as {
    session: Thread;
  }[];
  return hits.map((h) => h.session);
}

async function loadAgents(): Promise<Agent[]> {
  return JSON.parse(await ssh("claude agents --json --all")) as Agent[];
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const machine = (t: Thread) => (t.cwd.startsWith("/Users/") ? "Mac" : "Spark");
const resumeCommand = (t: Thread) => `atuin resume ${t.atuin_id}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const capture = () => tmux(`capture-pane -p -t ${q(pane(1))}`);

/** Re-read pane 1 every 80ms (one ~40ms round trip each) until `ok` holds; returns the last screen either way. */
async function settle(ok: (screen: string) => boolean, timeoutMs = 1500): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const screen = await capture();
    if (ok(screen) || Date.now() >= until) return screen;
    await sleep(80);
  }
}

class Refused extends Error {}

/** Open `agent` in pane 1's agent view via Ctrl+F find, verifying the pane before every keystroke. */
async function openInAgentView(agent: Agent, agents: Agent[]): Promise<void> {
  const name = agent.name.trim();
  if (!name) throw new Refused("this session has no name, so the agent view's find can't select it");
  const needle = name.toLowerCase();
  const clashes = agents.filter((a) => a.name.toLowerCase().includes(needle)).length;
  if (clashes !== 1) throw new Refused(`${clashes} sessions match "${name}" in the agent view; pick it there`);

  const t = q(pane(1));
  await tmux(`select-window -t ${q(`${prefs.session}:${prefs.window}`)}`, `select-pane -t ${t}`);
  // Raise the tab now, not at the end: the keystrokes below take a few hundred ms and are worth watching.
  const [drove, focused] = await Promise.allSettled([drivePane(t, name, needle), focusGhostty()]);
  if (drove.status === "rejected") throw drove.reason; // the pane outcome is what the user asked about
  if (focused.status === "rejected") throw focused.reason;
}

async function drivePane(t: string, name: string, needle: string): Promise<void> {

  // Bring pane 1 to "agents list, empty prompt, no find" from whatever it shows, one verified key at a
  // time (at most 3 steps). Only two keys are ever used here, each only in the state where it is proven
  // harmless: Esc while the footer says "esc to clear" (a find is open -- the agent view also restores
  // its last find on startup), and Left from inside a session whose prompt is empty ("← N agents").
  // Anything else refuses. Never Esc outside a find: there it QUITS the agent view.
  const findOpen = (sc: string) => sc.includes(FIND_MARK) && sc.includes("esc to clear");
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

  await tmux(`send-keys -t ${t} C-f`);
  if (!(await settle((sc) => sc.includes(FIND_MARK))).includes(FIND_MARK)) throw new Refused("Ctrl+F didn't open find in pane 1; nothing was typed");

  await tmux(`send-keys -t ${t} -l ${q(name)}`);
  const head = needle.slice(0, 30);
  const matchRows = (sc: string) =>
    sc.split("\n").filter((l) => !l.includes(FIND_MARK) && l.toLowerCase().includes(head)).length;
  const isReady = (sc: string) => /enter to (open|resume|return)/.test(sc) && !sc.includes("no sessions match");
  // The typed query shows in the find line once the view has caught up with it.
  // All three, on the SAME screen, before Enter: the find line shows the whole query (so the list is
  // filtered by it, not by a prefix still catching up), exactly one row carries the name, and the view
  // offers Enter on it.
  const queryShown = (sc: string) => sc.toLowerCase().includes(`${FIND_MARK} n:${needle}`);
  const found = await settle((sc) => queryShown(sc) && isReady(sc) && matchRows(sc) === 1);
  const rows = matchRows(found);
  if (!queryShown(found) || !isReady(found) || rows !== 1) {
    throw new Refused(`find shows ${rows} matching rows for "${name}"; left it open in pane 1 (Esc clears it)`);
  }

  await tmux(`send-keys -t ${t} Enter`);
}

async function pick(thread: Thread, agent: Agent | undefined, agents: Agent[]) {
  await closeMainWindow({ clearRootSearch: true });
  if (!agent) {
    await Clipboard.copy(resumeCommand(thread));
    await showHUD(`Not in the agent view: copied ${resumeCommand(thread)}`);
    return;
  }
  try {
    await openInAgentView(agent, agents);
    await showHUD(`Opened ${agent.name}`);
  } catch (e) {
    await Clipboard.copy(resumeCommand(thread));
    const why = e instanceof Refused ? e.message : String(e);
    await showToast({ style: Toast.Style.Failure, title: "Didn't open in pane 1 (resume command copied)", message: why });
  }
}

export default function Command() {
  const [text, setText] = useState("");
  const threads = useCachedPromise(loadThreads, [text], { keepPreviousData: true });
  const agents = useCachedPromise(loadAgents, [], { keepPreviousData: true });
  const bySession = new Map((agents.data ?? []).map((a) => [a.sessionId, a]));

  return (
    <List
      isLoading={threads.isLoading || agents.isLoading}
      filtering={false}
      throttle
      onSearchTextChange={setText}
      searchBarPlaceholder="Search past Claude sessions (Mac + Spark)…"
    >
      {(threads.data ?? []).map((t) => {
        const agent = bySession.get(t.session_id);
        return (
          <List.Item
            key={t.atuin_id}
            title={t.title || "untitled"}
            subtitle={[t.cwd.split("/").pop(), t.git_branch].filter(Boolean).join(" · ")}
            accessories={[
              agent
                ? { tag: { value: "agent view", color: Color.Green }, tooltip: `Opens in pane 1 (${agent.state})` }
                : { tag: { value: "copy", color: Color.SecondaryText }, tooltip: "Not in the agent view: Enter copies atuin resume" },
              { text: machine(t) },
              { text: `${t.message_count}` , tooltip: "messages" },
              { text: ago(t.updated_at), tooltip: new Date(t.updated_at).toLocaleString() },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={agent ? "Open in Pane 1 Agent View" : "Copy Resume Command"}
                  icon={agent ? Icon.Terminal : Icon.Clipboard}
                  onAction={() => pick(t, agent, agents.data ?? [])}
                />
                <Action.CopyToClipboard title="Copy Resume Command" content={resumeCommand(t)} />
                <Action.CopyToClipboard title="Copy Claude Session ID" content={t.session_id} />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={() => {
                    threads.revalidate();
                    agents.revalidate();
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
