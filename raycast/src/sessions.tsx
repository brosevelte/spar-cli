import { Action, ActionPanel, Clipboard, Color, Icon, List, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { execFile } from "node:child_process";
import { useState } from "react";
import { promisify } from "node:util";
import { focusGhostty, prefs, q, ssh, tmux } from "./spark";
import { FIND_MARK, Refused, paneTarget, settle, toAgentsList } from "./agentview";

const run = promisify(execFile);

// Past Claude Code sessions from BOTH machines, via atuin's thread capture (synced through the
// self-hosted atuin server on the Spark), searched locally on this Mac -- no ssh for the search.
//
// Picking one opens it in pane 1's agent view ONLY when the agent view can: it lists the Spark's
// background sessions, and its Ctrl+F find matches names (not ids). Anything else -- Mac sessions,
// plain `claude` sessions -- just copies `atuin resume <id>`; this command never opens windows or
// touches the layout for those (ruling 2026-10-30).
//
// Keystroke safety rules for the agent view live in agentview.ts.

interface Thread {
  atuin_id: string;
  session_id: string;
  cwd: string;
  git_branch: string | null;
  updated_at: string;
  message_count: number;
  title: string | null;
  preview: string | null; // the session's opening message
  last_reply: string | null;
}

interface Snippet {
  text: string;
  matches?: [number, number][];
}

/** A row: the session, plus (for a search) the message that matched and where. */
interface Hit {
  thread: Thread;
  match?: Snippet;
  messageIndex?: number;
}

interface Agent {
  id: string;
  sessionId: string;
  name: string;
  state: string;
}

async function atuin(args: string[]): Promise<string> {
  const { stdout } = await run(prefs.atuinPath, args, {
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ATUIN_SESSION: process.env.ATUIN_SESSION ?? "raycast" },
  });
  return stdout;
}

async function loadThreads(text: string): Promise<Hit[]> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return (JSON.parse(await atuin(["threads", "list", "--style", "json"])) as Thread[]).slice(0, 100).map((thread) => ({ thread }));
  }
  const hits = JSON.parse(await atuin(["threads", "search", "--style", "json", "--limit", "40", "--", ...words])) as {
    session: Thread;
    title: Snippet;
    preview: Snippet;
    message_index: number;
  }[];
  // A title match has an empty preview; the matched message is the preview otherwise.
  return hits.map((h) => ({
    thread: h.session,
    match: h.preview?.text ? h.preview : h.title?.text ? h.title : undefined,
    messageIndex: h.message_index,
  }));
}

/** Untitled sessions are mostly subagents; their opening brief is the best name they have. */
function displayTitle(t: Thread): string {
  if (t.title) return t.title;
  const line = (t.preview ?? "")
    .split("\n")
    .map((l) => l.replace(/<\/?[a-z_]+>/gi, "").trim())
    .find((l) => l.length > 0);
  return line ? `↳ ${line.slice(0, 80)}` : "untitled";
}

const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~]/g;
const mdEscape = (s: string) => s.replace(MD_SPECIAL, (c) => "\\" + c);

/** Markdown for a snippet with its matched ranges in bold. atuin's ranges are UTF-8 BYTE offsets. */
function highlight(sn: Snippet): string {
  const bytes = Buffer.from(sn.text, "utf8");
  const part = (a: number, b?: number) => mdEscape(bytes.subarray(a, b).toString("utf8"));
  const ranges = [...(sn.matches ?? [])].sort((x, y) => x[0] - y[0]);
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += part(at, a) + "**" + part(a, b) + "**";
    at = b;
  }
  return out + part(at);
}

const clip = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

function detailMarkdown(h: Hit): string {
  const parts: string[] = [];
  if (h.match) parts.push(`### Match${h.messageIndex !== undefined ? ` · message ${h.messageIndex}` : ""}\n\n${highlight(h.match)}`);
  if (h.thread.preview) parts.push(`### Opening message\n\n${mdEscape(clip(h.thread.preview, 600))}`);
  if (h.thread.last_reply) parts.push(`### Last reply\n\n${mdEscape(clip(h.thread.last_reply, 600))}`);
  return parts.join("\n\n---\n\n") || "_no preview_";
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
/** Open `agent` in pane 1's agent view via Ctrl+F find, verifying the pane before every keystroke. */
async function openInAgentView(agent: Agent, agents: Agent[]): Promise<void> {
  const name = agent.name.trim();
  if (!name) throw new Refused("this session has no name, so the agent view's find can't select it");
  const needle = name.toLowerCase();
  const clashes = agents.filter((a) => a.name.toLowerCase().includes(needle)).length;
  if (clashes !== 1) throw new Refused(`${clashes} sessions match "${name}" in the agent view; pick it there`);

  const t = paneTarget();
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
  await toAgentsList();

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
  const [showDetail, setShowDetail] = useState(true);
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
      isShowingDetail={showDetail}
    >
      {(threads.data ?? []).map((h) => {
        const t = h.thread;
        const agent = bySession.get(t.session_id);
        const where = [t.cwd.split("/").pop(), t.git_branch].filter(Boolean).join(" · ");
        return (
          <List.Item
            key={t.atuin_id}
            title={displayTitle(t)}
            subtitle={showDetail ? undefined : where}
            detail={
              <List.Item.Detail
                markdown={detailMarkdown(h)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Where" text={where} />
                    <List.Item.Detail.Metadata.Label title="Machine" text={machine(t)} />
                    <List.Item.Detail.Metadata.Label title="Messages" text={`${t.message_count}`} />
                    <List.Item.Detail.Metadata.Label title="Updated" text={new Date(t.updated_at).toLocaleString()} />
                    <List.Item.Detail.Metadata.TagList title="Enter">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={agent ? "opens in agent view" : "copies atuin resume"}
                        color={agent ? Color.Green : Color.SecondaryText}
                      />
                    </List.Item.Detail.Metadata.TagList>
                  </List.Item.Detail.Metadata>
                }
              />
            }
            accessories={showDetail ? (agent ? [{ icon: { source: Icon.Dot, tintColor: Color.Green }, tooltip: "in the agent view" }] : []) : [
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
                  title={showDetail ? "Hide Preview" : "Show Preview"}
                  icon={Icon.Sidebar}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  onAction={() => setShowDetail((v) => !v)}
                />
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
