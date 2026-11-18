import { LaunchProps, closeMainWindow, getPreferenceValues, open, showHUD } from "@raycast/api";

// Prefix -> GitHub repo whose PRs it names. A bare number is a PR in the first (BE) repo.
const REPOS: Record<string, string> = {
  BE: "equalparts-insurance/ultron-framework",
  FE: "equalparts-insurance/replit-avengetron",
};
const DEFAULT_REPO = REPOS.BE;
const LINEAR_WORKSPACE = "equalparts";

const graphite = (repo: string, n: string) => `https://app.graphite.com/github/pr/${repo}/${n}`;

// "TEC-4336" -> Linear issue; "BE-4228" / "4228" / "#4228" -> ultron-framework PR in Graphite;
// "FE-2030" -> replit-avengetron PR. Spaces, underscores and case are forgiven ("fe 2030", "tec_4336").
export function resolve(raw: string): { url: string; label: string } | undefined {
  const s = raw.trim().replace(/^@/, "").toUpperCase();
  const bare = s.match(/^#?(\d+)$/);
  if (bare) return { url: graphite(DEFAULT_REPO, bare[1]), label: `BE #${bare[1]}` };
  const m = s.match(/^([A-Z][A-Z0-9]*)[-_ ]+#?(\d+)$/);
  if (!m) return undefined;
  const [, prefix, n] = m;
  const repo = REPOS[prefix];
  if (repo) return { url: graphite(repo, n), label: `${prefix} #${n}` };
  return { url: `https://linear.app/${LINEAR_WORKSPACE}/issue/${prefix}-${n}`, label: `${prefix}-${n}` };
}

export default async function Command(props: LaunchProps<{ arguments: { ref: string } }>) {
  const hit = resolve(props.arguments.ref ?? "");
  if (!hit) {
    await showHUD(`Not a ticket or PR: ${props.arguments.ref}`);
    return;
  }
  const { browser } = getPreferenceValues<{ browser?: string }>();
  await closeMainWindow({ clearRootSearch: true });
  await open(hit.url, browser?.trim() || undefined);
  await showHUD(hit.label);
}
