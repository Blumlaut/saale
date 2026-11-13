/**
 * What a workspace reports about its GitHub sign-in, and how a `gh` answer is
 * read.
 *
 * A leaf module, like the sandbox variable names: the settings page renders
 * this in the browser and the workspace runs the command that fills it in.
 */

export const GITHUB_DEVICE_URL = "https://github.com/login/device";

/**
 * The only host this feature speaks to. Everything that names it imports it
 * from here, and this module imports nothing of its own.
 */
export const GITHUB_HOST = "github.com";

/** The host as a URL, for the credential helper's subsection. */
export const GITHUB_HOST_URL = `https://${GITHUB_HOST}`;

/** A refusal that quotes GitHub's body is cut to the line worth reading. */
const MAX_ERROR_LENGTH = 300;

/** What gh would answer with, and where it takes it from. */
export interface GithubCredential {
  host: string;
  login: string;
  /** Scopes GitHub granted, as gh reports them. Null when it reports none. */
  scopes: string | null;
  gitProtocol: string | null;
  /** gh's hosts file, or the name of the variable holding the token. */
  source: string;
}

/** What the integrations card and its dialog show. */
export interface GithubStatus {
  /** Null when no credential works, including when GitHub refused one. */
  credential: GithubCredential | null;
  /** A sign-in waiting for approval, with the code to type. */
  pending: { code: string | null; url: string } | null;
  error: string | null;
}

/** What a status read found: a working credential, or why the one it found is not. */
export interface GithubProbe {
  credential: GithubCredential | null;
  /**
   * The credential gh keeps in its own config, when it has one.
   *
   * `credential` is what a command would use, which may be a token Saale or the
   * account handed gh through the environment. That is not a login the workspace
   * made, and the source decision may only act on this one.
   */
  stored: GithubCredential | null;
  error: string | null;
}

/**
 * Whether gh took this token from the environment rather than from its config.
 *
 * gh reports the variable's name for a handed-in token and the path of its
 * `hosts.yml` for one it stored itself; a bare `"gh"` appears only when the
 * field is missing. So a source that reads like a variable name is the one to
 * reject — a path never does.
 */
export function isVariableTokenSource(source: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(source);
}

/** One host's entry in the `gh auth status --json hosts` answer. */
interface HostEntry {
  active?: boolean;
  state?: string;
  error?: string;
  host?: string;
  login?: string;
  scopes?: string;
  gitProtocol?: string;
  tokenSource?: string;
}

/**
 * The credential in a `gh auth status --json hosts` answer.
 *
 * gh lists every host it holds a token for, from its own config or from the
 * environment; the active one is what a command in the workspace would use. An
 * entry GitHub refused is reported as an error instead, because a card that
 * says "connected" over a revoked token is worse than one that says why.
 */
export function parseGithubHosts(stdout: string): GithubProbe {
  const text = stdout.trim();
  if (!text.startsWith("{")) return { credential: null, stored: null, error: null };

  let parsed: { hosts?: Record<string, HostEntry[]> };
  try {
    parsed = JSON.parse(text) as { hosts?: Record<string, HostEntry[]> };
  } catch (err) {
    console.error("Failed to read the GitHub CLI's auth status:", err);
    return { credential: null, stored: null, error: null };
  }

  const entries = Object.entries(parsed.hosts ?? {}).flatMap(([host, list]) =>
    (list ?? []).map((entry) => ({ host, entry })),
  );
  const chosen = entries.find(({ entry }) => entry.active) ?? entries[0];
  if (!chosen) return { credential: null, stored: null, error: null };

  if (chosen.entry.state === "error") {
    return {
      credential: null,
      stored: storedCredential(entries),
      error: firstLine(chosen.entry.error) ?? "GitHub refused the token",
    };
  }

  const login = chosen.entry.login?.trim();
  if (!login) return { credential: null, stored: storedCredential(entries), error: null };

  return {
    credential: {
      host: chosen.entry.host ?? chosen.host,
      login,
      scopes: chosen.entry.scopes?.trim() || null,
      gitProtocol: chosen.entry.gitProtocol?.trim() || null,
      source: chosen.entry.tokenSource?.trim() || "gh",
    },
    stored: storedCredential(entries),
    error: null,
  };
}

/**
 * What the card needs of one GitHub source.
 *
 * Declared here because the route assembles it and the hook reads it: a field
 * added on one side has to appear on the other, and a second copy is how the two
 * drift apart. `src/lib/integrations/github.ts` imports nothing, so the hook can
 * pull it into the browser bundle.
 */
export interface GithubAppSection {
  /** An admin saved an app and left it switched on. */
  configured: boolean;
  /** The app's slug, for the install link GitHub hosts. */
  slug: string | null;
  /** The app's display name. */
  name: string | null;
  /** The permissions the app was registered with. */
  permissions: Record<string, string> | null;
  /** The account authorized it. */
  authorized: { login: string; expiresAt: string | null } | null;
  /** Installations this account may use. */
  installations: {
    installationId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
    repositories: string[] | null;
    suspended: boolean;
  }[];
  /** A sign-in waiting for the user to type a code. */
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
}

/**
 * The repository permissions Saale works with.
 *
 * `GET /app` answers with whatever an app actually holds, so this list is what
 * the setup steps measure that answer against: an admin who registered the app
 * by hand reads here what is missing and what it costs. The last entry is the
 * one the repository picker needs — GitHub accepts those two calls only from an
 * app that holds it.
 */
export interface GithubAppPermission {
  /** The key in `GET /app`'s permissions map. */
  name: string;
  /** "read" or "write". */
  level: string;
  /** What a workspace loses without it. */
  why: string;
}

export const GITHUB_APP_PERMISSIONS: readonly GithubAppPermission[] = [
  { name: "contents", level: "write", why: "clone, fetch and push" },
  { name: "pull_requests", level: "write", why: "open and read pull requests" },
  { name: "workflows", level: "write", why: "push a branch that touches .github/workflows" },
  { name: "checks", level: "read", why: "the check badge on a branch" },
  { name: "metadata", level: "read", why: "every app has to ask for it" },
  {
    name: "installation_repositories",
    level: "write",
    why: "the repository picker adds and removes repositories",
  },
];

/** Whether a held level reaches what is asked for: write covers read, never the other way. */
function coversLevel(held: string | undefined, needed: string): boolean {
  return held === "write" || held === needed;
}

/** What an app's permission set is missing, in the order above. */
export function missingGithubAppPermissions(
  held: Record<string, string> | null | undefined,
): GithubAppPermission[] {
  return GITHUB_APP_PERMISSIONS.filter((entry) => !coversLevel(held?.[entry.name], entry.level));
}

/**
 * Whether the app may change its own installations, which the picker needs.
 *
 * The two installation calls take `installation_repositories: write`, a
 * permission GitHub has accepted only since October 2026. An app registered
 * before that can read an installation's repositories and nothing more, so the
 * card has to know the difference rather than offer a save GitHub refuses.
 */
export function appCanManageInstallations(
  held: Record<string, string> | null | undefined,
): boolean {
  return coversLevel(held?.installation_repositories, "write");
}

/** The entry gh keeps itself, skipping any it was handed through the environment. */
function storedCredential(entries: { host: string; entry: HostEntry }[]): GithubCredential | null {
  for (const { host, entry } of entries) {
    if (entry.state === "error") continue;
    // gh lists every host it holds a token for, and a login against an
    // enterprise host is not a login for github.com. Everything else in this
    // feature is github.com-only, so this must not answer for another host.
    const hostName = entry.host ?? host;
    if (hostName.toLowerCase() !== GITHUB_HOST) continue;
    const login = entry.login?.trim();
    if (!login) continue;
    const source = entry.tokenSource?.trim() || "gh";
    if (isVariableTokenSource(source)) continue;
    return {
      host: hostName,
      login,
      scopes: entry.scopes?.trim() || null,
      gitProtocol: entry.gitProtocol?.trim() || null,
      source,
    };
  }
  return null;
}

/** The one-time code in gh's output, e.g. `! First copy your one-time code: 1B47-ABE8`. */
export function findDeviceCode(output: string): string | null {
  const match = /one-time code[: ]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output);
  return match?.[1]?.toUpperCase() ?? null;
}

/** The first line of a message, cut to something a card can show. */
export function firstLine(message: string | undefined): string | null {
  const line = message
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, MAX_ERROR_LENGTH) : null;
}
