import { Action, ActionPanel, Icon, List, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { focusGhostty, listRepos, pane, prefs, q, repoPath, tmux } from "./spark";

// A literal cd into the shell pane (pane 2) -- deterministic where `z fra` depends on frecency.
async function go(repo: string) {
  try {
    await closeMainWindow({ clearRootSearch: true });
    const t = q(pane(2));
    await tmux(
      `select-window -t ${q(`${prefs.session}:${prefs.window}`)}`,
      `select-pane -t ${t}`,
      `send-keys -t ${t} ${q(`cd ${repoPath(repo)}`)} Enter`,
    );
    await focusGhostty();
    await showHUD(repo);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "cd failed", message: String(e) });
  }
}

export default function Command() {
  const { data, isLoading } = useCachedPromise(listRepos, [], { keepPreviousData: true });
  return (
    <List isLoading={isLoading} searchBarPlaceholder="cd into…">
      {(data ?? []).map((repo) => (
        <List.Item
          key={repo}
          title={repo}
          icon={Icon.Folder}
          actions={
            <ActionPanel>
              <Action title="Cd in Shell Pane" icon={Icon.Terminal} onAction={() => go(repo)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
