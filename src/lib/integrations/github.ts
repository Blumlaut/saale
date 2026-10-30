/**
 * What a workspace reports about its GitHub sign-in, and how a `gh` answer is
 * read.
 *
 * A leaf module, like the sandbox variable names: the settings page renders
 * this in the browser and the workspace runs the command that fills it in.
 */

export const GITHUB_DEVICE_URL = "https://github.com/login/device";

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
  error: string | null;
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
  if (!text.startsWith("{")) return { credential: null, error: null };

  let parsed: { hosts?: Record<string, HostEntry[]> };
  try {
    parsed = JSON.parse(text) as { hosts?: Record<string, HostEntry[]> };
  } catch (err) {
    console.error("Failed to read the GitHub CLI's auth status:", err);
    return { credential: null, error: null };
  }

  const entries = Object.entries(parsed.hosts ?? {}).flatMap(([host, list]) =>
    (list ?? []).map((entry) => ({ host, entry })),
  );
  const chosen = entries.find(({ entry }) => entry.active) ?? entries[0];
  if (!chosen) return { credential: null, error: null };

  if (chosen.entry.state === "error") {
    return { credential: null, error: firstLine(chosen.entry.error) ?? "GitHub refused the token" };
  }

  const login = chosen.entry.login?.trim();
  if (!login) return { credential: null, error: null };

  return {
    credential: {
      host: chosen.entry.host ?? chosen.host,
      login,
      scopes: chosen.entry.scopes?.trim() || null,
      gitProtocol: chosen.entry.gitProtocol?.trim() || null,
      source: chosen.entry.tokenSource?.trim() || "gh",
    },
    error: null,
  };
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
