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

// ─── What the workspace holds ────────────────────────────────────────────────

/**
 * The facts a decision needs, read from GitHub and from the workspace.
 *
 * Deliberately facts, not conclusions: whether a CLI login is present is a
 * property of the volume, whether the app is usable is a property of GitHub, and
 * neither may be inferred from the stored state — that inference is exactly the
 * lie a reconcile exists to catch.
 */
export interface GithubSourceFacts {
  /** An admin saved this instance's app and left it switched on. */
  appConfigured: boolean;
  /** The account authorized the app: a user-to-server token is stored. */
  appAuthorized: boolean;
  /** One of that account's installations reaches at least one repository. */
  appInstallation: boolean;
  /** The CLI credential found in the workspace, null when it has none. */
  cli: { login: string | null } | null;
}

/** What the instance offers and what the account had chosen. */
export interface GithubSourceInput {
  /** `AdminSettings.githubMethod`. */
  method: GithubMethod;
  /** `AppSettings.githubSource`. */
  source: GithubSource | "";
  facts: GithubSourceFacts;
}

/**
 * Why a decision differs from what was stored, in the card's words.
 *
 * Codes rather than sentences: the library decides, the card speaks. `login`
 * carries the GitHub account a notice is about, when it is about one.
 */
export type GithubSourceNoticeCode =
  /** A CLI login found in the workspace is now the active source. */
  | "adopted-cli"
  /** The app authorization is now the active source. */
  | "adopted-app"
  /** Strict app mode: the CLI login found in the workspace was removed. */
  | "removed-cli"
  /** The chosen CLI login is no longer in the workspace. */
  | "cli-gone"
  /** The app is authorized but installed nowhere that reaches a repository. */
  | "install-app"
  /** The instance is set to the app, but no app is saved. */
  | "app-not-configured"
  /** The instance no longer offers the app, so an app source was dropped. */
  | "app-not-offered"
  /** The stored app source cannot be used: the authorization or installation went. */
  | "app-not-usable";

export interface GithubSourceNotice {
  level: "info" | "warning";
  code: GithubSourceNoticeCode;
  /** The GitHub account the notice is about, when it is about one. */
  login?: string;
}

/** What the workspace should hold, and what the account should be told. */
export interface GithubSourceDecision {
  /** The source the workspace should carry. `""` links nothing. */
  target: GithubSource | "";
  /** Whether the stored state has to be rewritten. */
  changed: boolean;
  /** Lines for the connection card, in display order, each code at most once. */
  notices: GithubSourceNotice[];
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * Which source a workspace should have.
 *
 * Pure: the facts come in, a target and notices go out, so the whole table is
 * testable without a database, a container or GitHub. Applying it to the
 * workspace is `github-credentials.ts`'s job.
 *
 * The rule underneath every branch: a workspace carries **exactly one**
 * credential. Where the stored state and the workspace disagree the workspace
 * wins, because that is what a command would actually use — and the notice says
 * so, so nobody is surprised.
 */
export function decideGithubSource(input: GithubSourceInput): GithubSourceDecision {
  if (input.method === "app") return decideAppOnly(input);
  if (input.method === "cli") return decideCliOnly(input);
  return decideEither(input);
}

/** `method: "app"`: the app, or nothing. A CLI login is removed rather than adopted. */
function decideAppOnly(input: GithubSourceInput): GithubSourceDecision {
  const { source, facts } = input;

  // An instance pointed at an app that was never saved cannot honour the
  // setting. Falling back to the permissive rules and saying so beats tearing
  // down a working CLI login over a configuration mistake.
  if (!facts.appConfigured) {
    const fallback = decideEither({ method: "choice", source, facts });
    return finish(fallback.target, source, [warning("app-not-configured"), ...fallback.notices]);
  }

  if (appUsable(facts)) {
    const notices: GithubSourceNotice[] = [];
    if (facts.cli) notices.push(warning("removed-cli", facts.cli.login));
    if (source !== "app") notices.push(info("adopted-app"));
    return finish("app", source, notices);
  }

  const notices: GithubSourceNotice[] = [];
  if (facts.cli) notices.push(warning("removed-cli", facts.cli.login));
  if (facts.appAuthorized && !facts.appInstallation) notices.push(warning("install-app"));
  else if (source === "app") notices.push(warning("app-not-usable"));
  return finish("", source, notices);
}

/** `method: "cli"`: the CLI's own login, or nothing. */
function decideCliOnly(input: GithubSourceInput): GithubSourceDecision {
  const { source, facts } = input;

  if (facts.cli) {
    const notices = source === "cli" ? [] : [info("adopted-cli", facts.cli.login)];
    return finish("cli", source, notices);
  }

  const notices: GithubSourceNotice[] = [];
  if (source === "cli") notices.push(warning("cli-gone"));
  // An account that was on the app is told why it lost it, rather than being
  // left to guess from an empty card.
  if (source === "app") notices.push(info("app-not-offered"));
  return finish("", source, notices);
}

/** `method: "choice"`: whichever the account picked, adopting what it finds. */
function decideEither(input: GithubSourceInput): GithubSourceDecision {
  const { source, facts } = input;

  if (source === "app") {
    // A login made in the terminal is what a push would use, so it becomes the
    // answer instead of being reported and then ignored.
    if (facts.cli) return finish("cli", source, [info("adopted-cli", facts.cli.login)]);
    if (appUsable(facts)) return finish("app", source, []);
    // The user's own choice is not silently replaced by the other source: an
    // app that stopped working leaves the account unlinked until it acts.
    const code =
      facts.appConfigured || facts.appAuthorized ? "app-not-usable" : "app-not-configured";
    return finish("", source, [warning(code)]);
  }

  if (source === "cli") {
    // The account chose the CLI, so a vanished login is reported, not papered
    // over with the app it also happens to be authorized for.
    if (facts.cli) return finish("cli", source, []);
    return finish("", source, [warning("cli-gone")]);
  }

  // Nothing linked yet: take over whatever is present, which is how an instance
  // set up before the app existed ends up with its CLI login in the state.
  if (facts.cli) return finish("cli", source, [info("adopted-cli", facts.cli.login)]);
  if (appUsable(facts)) return finish("app", source, [info("adopted-app")]);
  if (facts.appAuthorized && !facts.appInstallation) {
    return finish("", source, [warning("install-app")]);
  }
  return finish("", source, []);
}

/** The app can serve a command: authorized, and reaching at least one repository. */
function appUsable(facts: GithubSourceFacts): boolean {
  return facts.appAuthorized && facts.appInstallation;
}

function info(code: GithubSourceNoticeCode, login?: string | null): GithubSourceNotice {
  return login ? { level: "info", code, login } : { level: "info", code };
}

function warning(code: GithubSourceNoticeCode, login?: string | null): GithubSourceNotice {
  return login ? { level: "warning", code, login } : { level: "warning", code };
}

/** The decision, with `changed` derived and any repeated code folded together. */
function finish(
  target: GithubSource | "",
  source: GithubSource | "",
  notices: readonly GithubSourceNotice[],
): GithubSourceDecision {
  const seen = new Set<string>();
  const unique: GithubSourceNotice[] = [];
  for (const notice of notices) {
    const key = `${notice.code}:${notice.login ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(notice);
  }
  return { target, changed: target !== source, notices: unique };
}
