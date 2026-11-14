// Menu bar companion to Claude Terminal: the one place a waiting Claude is visible when the popover
// is closed (in Focus, nothing else tells you). Every interval it reads the Claude panes on the box
// (one ssh call); a question mark and a count mean a session is asking you something, and the
// menu can answer Claude's own prompt (option 1 / option 3) or open the session.

import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, showHUD } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Pane, keys, listPanes } from "./term-backend";

const name = (p: Pane) => (p.session.startsWith("rc-") ? p.session.slice(3) : `${p.session} · ${p.window}`);
const ask = (p: Pane) => {
  const line = p.tail.split("\n").find((l) => /Do you want|Would you like/.test(l)) ?? p.tail.split("\n").slice(-6)[0] ?? "";
  const t = line.trim();
  return t.length > 70 ? t.slice(0, 70) + "…" : t;
};
const openPane = (p: Pane) => launchCommand({ name: "terminal", type: LaunchType.UserInitiated, context: { paneId: p.id } });

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(listPanes);
  const panes = data ?? [];
  const waiting = panes.filter((p) => p.state === "waiting");
  const working = panes.filter((p) => p.state === "working");

  const answer = async (p: Pane, key: string, label: string) => {
    try {
      await keys(p.id, key);
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
      tooltip={waiting.length ? "Claude needs you" : working.length ? "Claude is working" : "Claude on the Spark"}
    >
      {waiting.length > 0 && (
        <MenuBarExtra.Section title="Needs you">
          {waiting.map((p) => (
            <MenuBarExtra.Submenu key={p.id} title={`${name(p)} — ${ask(p)}`} icon={Icon.QuestionMarkCircle}>
              <MenuBarExtra.Item title="Yes (option 1)" icon={{ source: Icon.CheckCircle, tintColor: Color.Green }} onAction={() => answer(p, "1", "Answered yes")} />
              <MenuBarExtra.Item title="No (option 3)" icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }} onAction={() => answer(p, "3", "Answered no")} />
              <MenuBarExtra.Item title="Open" icon={Icon.Terminal} onAction={() => openPane(p)} />
            </MenuBarExtra.Submenu>
          ))}
        </MenuBarExtra.Section>
      )}
      {working.length > 0 && (
        <MenuBarExtra.Section title="Working">
          {working.map((p) => (
            <MenuBarExtra.Item key={p.id} title={name(p)} icon={Icon.CircleProgress} onAction={() => openPane(p)} />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Claude Terminal" icon={Icon.Terminal} onAction={() => launchCommand({ name: "terminal", type: LaunchType.UserInitiated })} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
