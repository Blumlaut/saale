/**
 * The two ways a workspace reaches GitHub, and the one that is active at a time.
 *
 * `cli` is the GitHub CLI's own login: the token `gh auth login` wrote to
 * `~/.config/gh` on the workspace volume, plus the credential helper it put in
 * `~/.gitconfig`. `app` is this instance's GitHub App, whose tokens Saale mints
 * on demand and hands in per command.
 *
 * They are exclusive by construction. Two credentials in one workspace means the
 * one git happens to try first decides what a push can reach, which is the
 * opposite of a guarantee — so a workspace carries exactly one of them, and this
 * module is the vocabulary that the stored state (`AppSettings.githubSource`)
 * and the instance policy (`AdminSettings.githubMethod`) are written in.
 *
 * A leaf module: the settings registry imports the value lists from here, so
 * nothing in this file may import the registry back.
 */

/** The sources a user can be linked through, in display order. */
export const GITHUB_SOURCES = ["app", "cli"] as const;

export type GithubSource = (typeof GITHUB_SOURCES)[number];

/** The value of `githubSource` when nothing is linked. */
export const GITHUB_SOURCE_NONE = "";

/** Every value `githubSource` may hold, "nothing linked" included. */
export const GITHUB_SOURCE_VALUES = [GITHUB_SOURCE_NONE, ...GITHUB_SOURCES] as const;

/** Whether `value` names a source that is actually linked. */
export function isGithubSource(value: unknown): value is GithubSource {
  return typeof value === "string" && (GITHUB_SOURCES as readonly string[]).includes(value);
}

/** Whether `value` is a storable `githubSource`, `""` included. */
export function isGithubSourceValue(value: unknown): value is GithubSource | "" {
  return value === GITHUB_SOURCE_NONE || isGithubSource(value);
}

/**
 * Which sources the instance offers.
 *
 * `choice` lets each account pick; `cli` and `app` offer one and remove the
 * other from a workspace that has it. The default keeps an instance that was
 * set up before the app existed working exactly as it did.
 */
export const GITHUB_METHODS = ["choice", "app", "cli"] as const;

export type GithubMethod = (typeof GITHUB_METHODS)[number];

/** What an instance offers when nobody said otherwise. */
export const GITHUB_METHOD_DEFAULT: GithubMethod = "choice";

export function isGithubMethod(value: unknown): value is GithubMethod {
  return typeof value === "string" && (GITHUB_METHODS as readonly string[]).includes(value);
}

/** A source's name, for a label or a log line. */
export function githubSourceLabel(source: GithubSource | ""): string {
  switch (source) {
    case "app":
      return "GitHub App";
    case "cli":
      return "GitHub CLI";
    default:
      return "not connected";
  }
}
