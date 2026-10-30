/**
 * A remote's https address, for links the panel opens.
 *
 * Two spellings reach the same repo: `https://host/owner/repo.git` and the
 * scp-like `git@host:owner/repo.git`. Both become a browsable URL, and anything
 * else — a local path, a file remote — becomes null so no link is offered.
 */

/** The https URL of a remote, or null when it does not have one. */
export function remoteWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (!trimmed.includes("://") && scp) {
    const [, host, path] = scp;
    if (!host || !path) return null;
    return `https://${host}/${stripGitSuffix(path).replace(/^\/+/, "")}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `https://${url.host}${stripGitSuffix(url.pathname)}`;
  } catch {
    return null;
  }
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** How well-known forges name themselves, so a menu item can say where it goes. */
const PLATFORM_NAMES: { pattern: RegExp; name: string }[] = [
  { pattern: /(^|\.)github\.com$/i, name: "GitHub" },
  { pattern: /(^|\.)gitlab\./i, name: "GitLab" },
  { pattern: /(^|\.)bitbucket\.(org|com)$/i, name: "Bitbucket" },
  { pattern: /(^|\.)codeberg\.org$/i, name: "Codeberg" },
  { pattern: /(^|\.)gitea\./i, name: "Gitea" },
  { pattern: /(^|\.)forgejo\./i, name: "Forgejo" },
];

/**
 * The name of the forge behind a remote, for a link that says where it opens.
 *
 * A host nobody recognises is still worth naming: "Open in git.acme.dev" tells
 * the user more than "Open in the remote".
 */
export function remoteHostName(remoteUrl: string): string | null {
  const web = remoteWebUrl(remoteUrl);
  if (!web) return null;
  let host: string;
  try {
    host = new URL(web).host;
  } catch {
    return null;
  }
  const known = PLATFORM_NAMES.find((platform) => platform.pattern.test(host));
  return known?.name ?? host.replace(/^www\./, "");
}

/** The page for one commit, for a commit row's link. */
export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  const base = remoteWebUrl(remoteUrl);
  if (!base || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  return `${base}/commit/${sha}`;
}

/** The page for the repo itself. */
export function repoWebUrl(remoteUrl: string): string | null {
  return remoteWebUrl(remoteUrl);
}
