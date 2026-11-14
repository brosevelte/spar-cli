// "Chat with Claude": Claude Code on the Spark, as a Raycast popover.
//
// The layout follows the Claude extension in the Raycast store (florisdobber/raycast-extensions,
// extensions/claude, MIT): the search bar is the composer, one list item per exchange, the reply in
// the detail pane. Everything behind it is different -- there is no API key or model call here; a
// turn is a detached `claude -p` on the box (chat-backend.ts, assets/spark-chat.py), so a chat is an
// ordinary Claude Code session with the box's tools, MCPs, memory and CLAUDE.md.
//
// Three things the composer does that a Raycast search bar doesn't on its own:
//   @ completion  -- while the text ends in `@<partial>`, the list turns into the repo's files and
//                    directories on the box; Enter inserts the path (a directory keeps you drilling).
//   images        -- Cmd-Shift-V attaches the clipboard image (a screenshot, or a copied image file);
//                    a fresh screenshot on the clipboard is offered as an item so it is one Enter.
//   drafts        -- saved per chat on every keystroke with their attachments, so closing Raycast to
//                    take a screenshot or check something loses nothing.

import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Form,
  Icon,
  Keyboard,
  List,
  LocalStorage,
  closeMainWindow,
  confirmAlert,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Attachment,
  Chat,
  Draft,
  ShowResult,
  Turn,
  attachFromClipboard,
  clipboardState,
  currentChatId,
  files,
  loadChats,
  loadDraft,
  newChat,
  removeChat,
  safeUnlink,
  saveDraft,
  send,
  setCurrentChat,
  show,
  stop,
  upsertChat,
} from "./chat-backend";
import { focusGhostty, listRepos, newWindow, prefs, repoPath } from "./spark";

const POLL_MS = 1500;
const CLIP_POLL_MS = 2000;
const CLIP_SEEN = "clipboardSeen";
const MENTION_AT_END = /(?:^|\s)@([^\s]*)$/;

// ---------------------------------------------------------------------------- rendering

// `$` starts a LaTeX span in Raycast's markdown (red text); Claude's text is otherwise markdown as-is.
const noMath = (s: string) => s.replace(/\$/g, "\\$");
const firstLine = (s: string, n = 80) => {
  const l = s.trim().split("\n")[0] ?? "";
  return l.length > n ? l.slice(0, n) + "…" : l;
};

function ago(ts: string | null): string {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function turnMarkdown(t: Turn, opts: { working: boolean; error: string | null }): string {
  const out: string[] = [];
  if (t.prompt.trim()) out.push(noMath(t.prompt).split("\n").map((l) => "> " + l).join("\n"));
  const extras = [
    ...(t.files.length ? [`📎 ${t.files.map((f) => "`" + f + "`").join(", ")}`] : []),
    ...(t.images > 0 ? [`🖼 ${t.images} image${t.images > 1 ? "s" : ""}`] : []),
  ];
  if (extras.length) out.push(extras.join(" · "));
  out.push("---");
  let tools: string[] = [];
  const flush = () => {
    if (tools.length) out.push(tools.join("  \n"));
    tools = [];
  };
  for (const p of t.parts) {
    if (p.t === "tool") {
      tools.push(`\`${p.error ? "✗" : "⚙"} ${p.name}\`${p.desc ? " — " + noMath(p.desc) : ""}`);
    } else {
      flush();
      out.push(noMath(p.text ?? ""));
    }
  }
  flush();
  if (opts.working) out.push("_Claude is working…_");
  if (opts.error) out.push(`**⚠ The last turn failed**\n\n\`\`\`\n${opts.error}\n\`\`\``);
  return out.join("\n\n");
}

const lastReply = (t: Turn) =>
  t.parts
    .filter((p) => p.t === "text")
    .map((p) => p.text)
    .join("\n\n");

// ---------------------------------------------------------------------------- @ completion

/** Higher is better; -1 is no match. Basename hits beat path hits beat a scattered subsequence. */
function score(p: string, q: string): number {
  const lp = p.toLowerCase();
  const lq = q.toLowerCase();
  const trimmed = lp.endsWith("/") ? lp.slice(0, -1) : lp;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (base.startsWith(lq)) return 4000 - p.length;
  if (base.includes(lq)) return 3000 - p.length;
  if (lp.startsWith(lq)) return 2500 - p.length;
  if (lp.includes(lq)) return 2000 - p.length;
  let i = 0;
  for (const ch of lp) if (ch === lq[i] && ++i === lq.length) return 1000 - p.length;
  return -1;
}

function candidates(all: string[], q: string): string[] {
  if (!q) return all.filter((p) => !p.replace(/\/$/, "").includes("/")).slice(0, 80);
  return all
    .map((p) => [p, score(p, q)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([p]) => p);
}

// ---------------------------------------------------------------------------- the command

interface Pending {
  prompt: string;
  images: number;
  before: number;
  at: number;
}

export default function Command() {
  const { push, pop } = useNavigation();
  const [chat, setChat] = useState<Chat>();
  const [draft, setDraftState] = useState<Draft>({ text: "", attachments: [] });
  const [result, setResult] = useState<ShowResult>();
  const [pending, setPending] = useState<Pending>();
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [clip, setClip] = useState<{ count: number; image: boolean }>();
  const [clipSeen, setClipSeen] = useState<number>();
  const [selected, setSelected] = useState<string>();
  const chatRef = useRef<Chat | undefined>(undefined);
  chatRef.current = chat;

  // ---- load the current chat and its draft (the draft is what makes jumping away safe)
  const openChat = useCallback(async (c: Chat) => {
    await upsertChat(c);
    await setCurrentChat(c.id);
    setResult(undefined);
    setPending(undefined);
    setLoadError(undefined);
    setSelected(undefined);
    setChat(c);
    setDraftState(await loadDraft(c.id));
  }, []);

  useEffect(() => {
    (async () => {
      const [id, chats, seen] = await Promise.all([currentChatId(), loadChats(), LocalStorage.getItem<number>(CLIP_SEEN)]);
      setClipSeen(seen);
      await openChat(chats.find((c) => c.id === id) ?? chats[0] ?? newChat(prefs.chatDefaultDir || prefs.srcDir));
    })();
  }, []);

  const setDraft = useCallback((d: Draft) => {
    setDraftState(d);
    const c = chatRef.current;
    if (c) saveDraft(c.id, d);
  }, []);

  // ---- the conversation: read once per chat, then every POLL_MS while a turn is in flight
  useEffect(() => {
    if (!chat) return;
    let alive = true;
    show(chat.id)
      .then((r) => {
        if (!alive) return;
        setResult(r);
        setLoadError(undefined);
        setPending((p) => (p && (r.turns.length > p.before || (!r.running && Date.now() - p.at > 8000)) ? undefined : p));
        const title = r.title || (r.turns[0] ? firstLine(r.turns[0].prompt, 60) : undefined);
        if (title && title !== chat.title) {
          const c = { ...chat, title };
          upsertChat(c);
          setChat(c);
        }
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
    };
  }, [chat?.id, tick]);

  const busy = Boolean(result?.running || pending);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setTick((x) => x + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [busy, tick]);

  // Newest exchange selected whenever one arrives; otherwise selection is yours.
  const turns = useMemo(() => [...(result?.turns ?? [])].reverse(), [result]);
  useEffect(() => {
    setSelected(pending ? "pending" : turns[0]?.id);
  }, [turns.length, Boolean(pending)]);

  // ---- clipboard watch: a fresh image on the clipboard is offered as an attachment
  useEffect(() => {
    let alive = true;
    const check = () =>
      clipboardState()
        .then((s) => alive && setClip(s))
        .catch(() => undefined);
    check();
    const t = setInterval(check, CLIP_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const markClipSeen = (count: number) => {
    setClipSeen(count);
    LocalStorage.setItem(CLIP_SEEN, count);
  };
  const offerClipboard = Boolean(clip?.image && clip.count !== clipSeen);

  // ---- @ files for this chat's directory (cached across opens)
  const index = useCachedPromise(files, [chat?.cwd ?? ""], { execute: Boolean(chat), keepPreviousData: true });
  const mention = MENTION_AT_END.exec(draft.text);
  const mentionQuery = mention ? mention[1] : undefined;
  const fileItems = useMemo(
    () => (mentionQuery === undefined || !index.data ? [] : candidates([...index.data.dirs, ...index.data.files], mentionQuery)),
    [mentionQuery, index.data],
  );

  // ---------------------------------------------------------------------------- actions

  async function attachClipboard() {
    try {
      const a = await attachFromClipboard();
      const s = await clipboardState().catch(() => undefined);
      if (s) markClipSeen(s.count);
      setDraft({ ...draft, attachments: [...draft.attachments, a] });
      showToast({ style: Toast.Style.Success, title: "Image attached" });
    } catch (e) {
      showToast({ style: Toast.Style.Failure, title: "No image to attach", message: String(e) });
    }
  }

  function removeAttachment(a: Attachment) {
    safeUnlink(a.path);
    setDraft({ ...draft, attachments: draft.attachments.filter((x) => x.path !== a.path) });
  }

  function insertMention(p: string) {
    const m = MENTION_AT_END.exec(draft.text);
    if (!m) return;
    const start = draft.text.length - m[1].length - 1;
    // A directory keeps the completion open so you can keep drilling; a file ends it with a space.
    setDraft({ ...draft, text: draft.text.slice(0, start) + "@" + p + (p.endsWith("/") ? "" : " ") });
  }

  async function doSend(text = draft.text) {
    if (!chat) return;
    if (!text.trim() && !draft.attachments.length) return;
    if (result?.running || pending) {
      showToast({ style: Toast.Style.Failure, title: "Claude is still working", message: "Stop it (⌘.) or wait — your draft is kept." });
      return;
    }
    const sent: Draft = { text, attachments: draft.attachments };
    setPending({ prompt: text, images: sent.attachments.length, before: result?.turns.length ?? 0, at: Date.now() });
    setDraft({ text: "", attachments: [] });
    try {
      await send(chat, text, sent.attachments);
      sent.attachments.forEach((a) => safeUnlink(a.path));
      const c = { ...chat, title: chat.title === "New chat" && text.trim() ? firstLine(text, 60) : chat.title, updatedAt: Date.now() };
      await upsertChat(c);
      setChat(c);
      setTick((x) => x + 1);
    } catch (e) {
      setPending(undefined);
      setDraft(sent); // nothing is lost on a failed send
      showToast({ style: Toast.Style.Failure, title: "Send failed", message: String(e) });
    }
  }

  async function doStop() {
    if (!chat) return;
    const stopped = await stop(chat.id).catch(() => false);
    showToast({ style: stopped ? Toast.Style.Success : Toast.Style.Failure, title: stopped ? "Stopped" : "Nothing running" });
    setTick((x) => x + 1);
  }

  async function openInGhostty() {
    if (!chat) return;
    if (busy) {
      showToast({ style: Toast.Style.Failure, title: "Wait for the turn to finish", message: "Two Claudes writing one session would fork it." });
      return;
    }
    await closeMainWindow({ clearRootSearch: true });
    await newWindow(`chat-${chat.id.slice(0, 6)}`, chat.cwd, `claude --resume ${chat.id}`);
    await focusGhostty();
  }

  const chatActions = (
    <>
      <ActionPanel.Section title="Chat">
        <Action
          title="Paste Image"
          icon={Icon.Image}
          shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
          onAction={attachClipboard}
        />
        <Action.Push
          title="Edit Draft (Multi-line)"
          icon={Icon.Pencil}
          shortcut={{ modifiers: ["cmd"], key: "e" }}
          target={<DraftForm draft={draft} onChange={setDraft} onSend={(t) => (pop(), doSend(t))} />}
        />
        {busy && <Action title="Stop Claude" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={doStop} />}
        <Action
          title="New Chat…"
          icon={Icon.PlusCircle}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={() => push(<NewChat onPick={(c) => (pop(), openChat(c))} />)}
        />
        <Action
          title="Switch Chat…"
          icon={Icon.List}
          shortcut={{ modifiers: ["cmd"], key: "p" }}
          onAction={() => push(<SwitchChat current={chat?.id} onPick={(c) => (pop(), openChat(c))} />)}
        />
        <Action title="Open in Ghostty" icon={Icon.Terminal} shortcut={Keyboard.Shortcut.Common.Open} onAction={openInGhostty} />
        <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={() => setTick((x) => x + 1)} />
      </ActionPanel.Section>
      {(draft.text || draft.attachments.length > 0) && (
        <ActionPanel.Section>
          <Action
            title="Discard Draft"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
            onAction={() => {
              draft.attachments.forEach((a) => safeUnlink(a.path));
              setDraft({ text: "", attachments: [] });
            }}
          />
        </ActionPanel.Section>
      )}
    </>
  );

  const sendAction = (shortcut?: Keyboard.Shortcut) =>
    draft.text.trim() || draft.attachments.length ? (
      <Action title="Send to Claude" icon={Icon.ArrowUpCircle} shortcut={shortcut} onAction={() => doSend()} />
    ) : null;

  // ---------------------------------------------------------------------------- views

  const placeholder = chat
    ? `${busy ? "Claude is working… draft your next message" : "Message Claude"} · ${chat.cwd.replace(/^.*\//, "") || chat.cwd}  (@ for files)`
    : "Loading…";

  if (mentionQuery !== undefined) {
    return (
      <List
        searchText={draft.text}
        onSearchTextChange={(text) => setDraft({ ...draft, text })}
        filtering={false}
        throttle={false}
        isLoading={index.isLoading}
        searchBarPlaceholder={placeholder}
        navigationTitle={chat?.title}
      >
        <List.Section title={`Files in ${index.data?.cwd ?? chat?.cwd ?? ""}`} subtitle={String(fileItems.length)}>
          {fileItems.map((p) => (
            <List.Item
              key={p}
              id={"file:" + p}
              title={p}
              icon={p.endsWith("/") ? Icon.Folder : Icon.Document}
              actions={
                <ActionPanel>
                  <Action title="Insert" icon={Icon.Plus} onAction={() => insertMention(p)} />
                  {sendAction({ modifiers: ["cmd"], key: "return" })}
                  {chatActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
        {!index.isLoading && fileItems.length === 0 && <List.EmptyView title="No matching files" icon={Icon.MagnifyingGlass} />}
      </List>
    );
  }

  return (
    <List
      searchText={draft.text}
      onSearchTextChange={(text) => setDraft({ ...draft, text })}
      filtering={false}
      throttle={false}
      isShowingDetail={turns.length > 0 || Boolean(pending) || draft.attachments.length > 0 || offerClipboard}
      isLoading={!chat || (!result && !loadError) || busy}
      selectedItemId={selected}
      onSelectionChange={(id) => id && setSelected(id)}
      searchBarPlaceholder={placeholder}
      navigationTitle={chat?.title}
      actions={
        <ActionPanel>
          {sendAction()}
          {chatActions}
        </ActionPanel>
      }
    >
      {(draft.attachments.length > 0 || offerClipboard) && (
        <List.Section title="Attachments">
          {draft.attachments.map((a) => (
            <List.Item
              key={a.path}
              id={"att:" + a.path}
              title={a.name}
              icon={{ source: a.path }}
              accessories={[{ tag: { value: "attached", color: Color.Green } }]}
              detail={<List.Item.Detail markdown={`![${a.name}](${encodeURI("file://" + a.path)})`} />}
              actions={
                <ActionPanel>
                  {sendAction()}
                  <Action
                    title="Remove Attachment"
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    shortcut={Keyboard.Shortcut.Common.Remove}
                    onAction={() => removeAttachment(a)}
                  />
                  {chatActions}
                </ActionPanel>
              }
            />
          ))}
          {offerClipboard && clip && (
            <List.Item
              id="clipboard"
              title="Attach the image on your clipboard"
              icon={Icon.Clipboard}
              accessories={[{ text: "⌘⇧V" }]}
              detail={<List.Item.Detail markdown="A screenshot or image is on the clipboard. **Enter** attaches it; **⌃X** ignores it." />}
              actions={
                <ActionPanel>
                  <Action title="Attach Clipboard Image" icon={Icon.Image} onAction={attachClipboard} />
                  {sendAction({ modifiers: ["cmd"], key: "return" })}
                  <Action
                    title="Ignore This Image"
                    icon={Icon.EyeDisabled}
                    shortcut={Keyboard.Shortcut.Common.Remove}
                    onAction={() => markClipSeen(clip.count)}
                  />
                  {chatActions}
                </ActionPanel>
              }
            />
          )}
        </List.Section>
      )}
      <List.Section title={chat?.title ?? "Chat"} subtitle={chat?.cwd}>
        {pending && (
          <List.Item
            id="pending"
            title={firstLine(pending.prompt) || "🖼 image"}
            icon={{ source: Icon.CircleProgress, tintColor: Color.Orange }}
            accessories={[{ text: "sending" }]}
            detail={<List.Item.Detail markdown={`> ${noMath(pending.prompt).split("\n").join("\n> ")}\n\n---\n\n_Starting Claude on the box…_`} />}
            actions={<ActionPanel>{chatActions}</ActionPanel>}
          />
        )}
        {turns.map((t, i) => {
          const latest = i === 0 && !pending;
          const working = latest && Boolean(result?.running);
          const err = latest && !result?.running ? result?.error ?? null : null;
          return (
            <List.Item
              key={t.id}
              id={t.id}
              title={firstLine(t.prompt) || (t.images ? "🖼 image" : "…")}
              icon={
                working
                  ? { source: Icon.CircleProgress, tintColor: Color.Orange }
                  : err
                    ? { source: Icon.Warning, tintColor: Color.Red }
                    : Icon.Message
              }
              accessories={[
                ...(t.images ? [{ icon: Icon.Image, text: String(t.images) }] : []),
                ...(t.files.length ? [{ icon: Icon.Paperclip, text: String(t.files.length) }] : []),
                { text: ago(t.ts) },
              ]}
              detail={<List.Item.Detail markdown={turnMarkdown(t, { working, error: err })} />}
              actions={
                <ActionPanel>
                  {sendAction()}
                  <Action.CopyToClipboard title="Copy Reply" content={lastReply(t)} shortcut={Keyboard.Shortcut.Common.Copy} />
                  <Action.CopyToClipboard
                    title="Copy Session ID"
                    content={chat?.id ?? ""}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
                  />
                  {chatActions}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      {chat && result && turns.length === 0 && !pending && (
        <List.EmptyView
          icon={Icon.Message}
          title="Message Claude on the Spark"
          description={`Runs in ${chat.cwd}. Type below, @ for files, ⌘⇧V to paste an image, ⌘E for a multi-line draft.`}
        />
      )}
      {loadError && <List.EmptyView icon={Icon.Warning} title="Can't reach the box" description={loadError} />}
    </List>
  );
}

// ---------------------------------------------------------------------------- sub-views

function DraftForm(props: { draft: Draft; onChange: (d: Draft) => void; onSend: (text: string) => void }) {
  const [text, setText] = useState(props.draft.text);
  return (
    <Form
      navigationTitle="Draft"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send to Claude" icon={Icon.ArrowUpCircle} onSubmit={() => props.onSend(text)} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="text"
        title="Message"
        value={text}
        onChange={(t) => {
          setText(t);
          props.onChange({ ...props.draft, text: t });
        }}
        enableMarkdown
        autoFocus
      />
      <Form.Description
        text={`${props.draft.attachments.length} image(s) attached. ⌘↵ sends. @ completion lives in the main composer: Esc back to it.`}
      />
    </Form>
  );
}

function NewChat(props: { onPick: (c: Chat) => void }) {
  const repos = useCachedPromise(listRepos, [], { keepPreviousData: true });
  const dirs = [prefs.chatDefaultDir || prefs.srcDir, "~"];
  return (
    <List isLoading={repos.isLoading} searchBarPlaceholder="Where should Claude work?" navigationTitle="New Chat">
      <List.Section title="Directories">
        {dirs.map((d) => (
          <List.Item key={d} title={d} icon={Icon.Folder} actions={<ActionPanel><Action title="Start Chat Here" onAction={() => props.onPick(newChat(d))} /></ActionPanel>} />
        ))}
      </List.Section>
      <List.Section title="Repos">
        {(repos.data ?? []).map((r) => (
          <List.Item
            key={r}
            title={r}
            icon={Icon.Code}
            actions={<ActionPanel><Action title="Start Chat Here" onAction={() => props.onPick(newChat(repoPath(r)))} /></ActionPanel>}
          />
        ))}
      </List.Section>
    </List>
  );
}

function SwitchChat(props: { current?: string; onPick: (c: Chat) => void }) {
  const chats = useCachedPromise(loadChats, []);
  return (
    <List isLoading={chats.isLoading} searchBarPlaceholder="Switch chat…" navigationTitle="Chats">
      {(chats.data ?? []).map((c) => (
        <List.Item
          key={c.id}
          title={c.title}
          subtitle={c.cwd}
          icon={c.id === props.current ? Icon.CheckCircle : Icon.Message}
          accessories={[{ date: new Date(c.updatedAt) }]}
          actions={
            <ActionPanel>
              <Action title="Open Chat" onAction={() => props.onPick(c)} />
              <Action
                title="Forget Chat"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={async () => {
                  const ok = await confirmAlert({
                    title: "Forget this chat?",
                    message: "Removes it and its draft from Raycast. The Claude session stays on the box (claude --resume).",
                    primaryAction: { title: "Forget", style: Alert.ActionStyle.Destructive },
                  });
                  if (ok) {
                    await removeChat(c.id);
                    chats.revalidate();
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
