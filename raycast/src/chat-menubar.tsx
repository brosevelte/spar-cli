// Menu bar companion to Claude Terminal: the one place a waiting Claude is visible when the popover
// is closed (in Focus, nothing else tells you). Every interval it reads `claude agents` on the box
// (one ssh call): a question mark and a count mean a session needs you. Yes / No answer Claude's own
// prompt through Raycast's attached pane; Open goes to the conversation.

import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, showHUD } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Agent, ensureAttached, keys, listAgents } from "./term-backend";

const openAgent = (a: Agent) => launchCommand({ name: "terminal", type: LaunchType.UserInitiated, context: { agentId: a.id } });

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(listAgents);
  const agents = data ?? [];
  const waiting = agents.filter((a) => a.state === "needs");
  const working = agents.filter((a) => a.state === "working");

  const answer = async (a: Agent, key: string, label: string) => {
    try {
      await keys(await ensureAttached(a.id), key);
      await showHUD(label);
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
            : { source: Icon.Terminal, tintColor: { light: "#888888", dark: "#888888" } }
      }
      title={waiting.length ? String(waiting.length) : undefined}
      tooltip={waiting.length ? "Claude needs you" : working.length ? `${working.length} working` : "Claude on the Spark"}
    >
      {waiting.length > 0 && (
        <MenuBarExtra.Section title="Needs you">
          {waiting.map((a) => (
            <MenuBarExtra.Submenu key={a.id} title={a.name} icon={Icon.QuestionMarkCircle}>
              <MenuBarExtra.Item title="Yes (option 1)" icon={{ source: Icon.CheckCircle, tintColor: Color.Green }} onAction={() => answer(a, "1", "Answered yes")} />
              <MenuBarExtra.Item title="No (option 3)" icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }} onAction={() => answer(a, "3", "Answered no")} />
              <MenuBarExtra.Item title="Open" icon={Icon.Message} onAction={() => openAgent(a)} />
            </MenuBarExtra.Submenu>
          ))}
        </MenuBarExtra.Section>
      )}
      {working.length > 0 && (
        <MenuBarExtra.Section title="Working">
          {working.map((a) => (
            <MenuBarExtra.Item key={a.id} title={a.name} icon={Icon.CircleProgress} onAction={() => openAgent(a)} />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Claude Terminal" icon={Icon.Terminal} onAction={() => launchCommand({ name: "terminal", type: LaunchType.UserInitiated })} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
