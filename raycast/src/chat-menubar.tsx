// Menu bar companion to "Chat with Claude": the one place a pending approval is visible when the
// popover is closed (in Focus, notifications don't show). Refreshes on the manifest's interval with
// one ssh round trip for the recent chats; a hand and a count mean Claude is waiting on you, and the
// request can be approved or denied right from the menu.

import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, showHUD } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Chat, Status, decide, loadChats, permissionSummary, status } from "./chat-backend";

async function load(): Promise<{ chats: Chat[]; st: Status }> {
  const chats = (await loadChats()).slice(0, 15);
  return { chats, st: chats.length ? await status(chats.map((c) => c.id)) : {} };
}

const openChat = (c: Chat) => launchCommand({ name: "chat", type: LaunchType.UserInitiated, context: { chatId: c.id } });

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(load);
  const chats = data?.chats ?? [];
  const st = data?.st ?? {};
  const waiting = chats.filter((c) => st[c.id]?.permission);
  const working = chats.filter((c) => st[c.id]?.running && !st[c.id]?.permission);

  const answer = async (c: Chat, behavior: "allow" | "deny") => {
    const p = st[c.id]?.permission;
    if (!p) return;
    try {
      await decide(c.id, p.id, behavior);
      await showHUD(behavior === "allow" ? "Approved" : "Denied");
    } catch (e) {
      await showHUD(`Couldn't answer: ${e}`);
    }
    revalidate();
  };

  return (
    <MenuBarExtra
      isLoading={isLoading}
      icon={
        waiting.length
          ? { source: Icon.QuestionMarkCircle, tintColor: Color.Orange }
          : working.length
            ? { source: Icon.CircleProgress, tintColor: { light: "#555555", dark: "#BBBBBB" } }
            : { source: Icon.Message, tintColor: { light: "#888888", dark: "#888888" } }
      }
      title={waiting.length ? String(waiting.length) : undefined}
      tooltip={waiting.length ? "Claude is waiting for your approval" : working.length ? "Claude is working" : "Claude on the Spark"}
    >
      {waiting.length > 0 && (
        <MenuBarExtra.Section title="Waiting for approval">
          {waiting.map((c) => (
            <MenuBarExtra.Submenu key={c.id} title={`${c.title} — ${permissionSummary(st[c.id]!.permission!)}`} icon={Icon.QuestionMarkCircle}>
              <MenuBarExtra.Item title="Approve" icon={{ source: Icon.CheckCircle, tintColor: Color.Green }} onAction={() => answer(c, "allow")} />
              <MenuBarExtra.Item title="Deny" icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }} onAction={() => answer(c, "deny")} />
              <MenuBarExtra.Item title="Open Chat" icon={Icon.Message} onAction={() => openChat(c)} />
            </MenuBarExtra.Submenu>
          ))}
        </MenuBarExtra.Section>
      )}
      {working.length > 0 && (
        <MenuBarExtra.Section title="Working">
          {working.map((c) => (
            <MenuBarExtra.Item key={c.id} title={c.title} icon={Icon.CircleProgress} onAction={() => openChat(c)} />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Chat with Claude" icon={Icon.Message} onAction={() => launchCommand({ name: "chat", type: LaunchType.UserInitiated })} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
