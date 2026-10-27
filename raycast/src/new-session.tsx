import { Action, ActionPanel, Icon, List, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { focusGhostty, listRepos, newWindow, repoPath } from "./spark";

async function start(repo: string, cmd: string) {
  try {
    await closeMainWindow({ clearRootSearch: true });
    await newWindow(repo, repoPath(repo), cmd);
    await focusGhostty();
    await showHUD(`${cmd} in ${repo}`);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "Start failed", message: String(e) });
  }
}

export default function Command() {
  const { data, isLoading } = useCachedPromise(listRepos, [], { keepPreviousData: true });
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Start Claude in…">
      {(data ?? []).map((repo) => (
        <List.Item
          key={repo}
          title={repo}
          icon={Icon.Folder}
          actions={
            <ActionPanel>
              <Action title="New Claude Session" icon={Icon.Terminal} onAction={() => start(repo, "claude")} />
              <Action title="Continue Last Session Here" icon={Icon.Redo} onAction={() => start(repo, "claude --continue")} />
              <Action title="New Shell Window" icon={Icon.Window} onAction={() => start(repo, "clear")} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
