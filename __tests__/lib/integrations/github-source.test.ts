import { describe, expect, it } from "vitest";
import {
  decideGithubSource,
  isGithubMethod,
  isGithubSource,
  isGithubSourceValue,
  type GithubSourceFacts,
  type GithubSourceInput,
  type GithubSourceNoticeCode,
} from "@/lib/integrations/github-source";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A workspace with nothing in it and an instance with no app. */
const EMPTY: GithubSourceFacts = {
  appConfigured: false,
  appAuthorized: false,
  appInstallation: false,
  cli: null,
};

function facts(overrides: Partial<GithubSourceFacts> = {}): GithubSourceFacts {
  return { ...EMPTY, ...overrides };
}

/** An instance that saved its app, and an account that authorized and installed it. */
const APP_READY = { appConfigured: true, appAuthorized: true, appInstallation: true } as const;

/** A CLI login in the workspace, as gh would report it. */
const CLI = { cli: { login: "octocat" } } as const;

function decide(input: Partial<GithubSourceInput> & Pick<GithubSourceInput, "facts">) {
  return decideGithubSource({ method: "choice", source: "", ...input });
}

function codes(input: Partial<GithubSourceInput> & Pick<GithubSourceInput, "facts">) {
  return decide(input).notices.map((notice) => notice.code);
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

describe("the github source vocabulary", () => {
  it("knows the two sources and the unlinked value", () => {
    expect(isGithubSource("app")).toBe(true);
    expect(isGithubSource("cli")).toBe(true);
    expect(isGithubSource("both")).toBe(false);

    expect(isGithubSourceValue("")).toBe(true);
    expect(isGithubSourceValue("app")).toBe(true);
    expect(isGithubSourceValue(undefined)).toBe(false);
  });

  it("knows the methods an instance can offer", () => {
    for (const method of ["choice", "app", "cli"]) expect(isGithubMethod(method)).toBe(true);
    expect(isGithubMethod("both")).toBe(false);
    expect(isGithubMethod(null)).toBe(false);
  });
});

// ─── Existing instances ──────────────────────────────────────────────────────

describe("an instance that predates the app", () => {
  it("adopts the CLI login instead of asking the user to reconnect", () => {
    const decision = decide({ source: "", facts: facts(CLI) });

    expect(decision.target).toBe("cli");
    expect(decision.changed).toBe(true);
    expect(decision.notices).toEqual([{ level: "info", code: "adopted-cli", login: "octocat" }]);
  });

  it("leaves a workspace with nothing in it unlinked and quiet", () => {
    const decision = decide({ source: "", facts: facts() });

    expect(decision.target).toBe("");
    expect(decision.changed).toBe(false);
    expect(decision.notices).toEqual([]);
  });
});

describe("choosing either source", () => {
  it("takes over the app authorization when nothing was chosen yet", () => {
    const decision = decide({ source: "", facts: facts(APP_READY) });

    expect(decision.target).toBe("app");
    expect(decision.changed).toBe(true);
    expect(decision.notices.map((notice) => notice.code)).toEqual(["adopted-app"]);
  });

  it("keeps the app while it is usable", () => {
    const decision = decide({ source: "app", facts: facts(APP_READY) });

    expect(decision.target).toBe("app");
    expect(decision.changed).toBe(false);
    expect(decision.notices).toEqual([]);
  });

  it("adopts a login made in the terminal over a stored app source", () => {
    const decision = decide({ source: "app", facts: facts({ ...APP_READY, ...CLI }) });

    expect(decision.target).toBe("cli");
    expect(decision.changed).toBe(true);
    expect(decision.notices.map((notice) => notice.code)).toEqual(["adopted-cli"]);
  });

  it("reports a chosen CLI login that disappeared rather than falling back to the app", () => {
    const decision = decide({ source: "cli", facts: facts(APP_READY) });

    expect(decision.target).toBe("");
    expect(decision.changed).toBe(true);
    expect(decision.notices.map((notice) => notice.code)).toEqual(["cli-gone"]);
  });

  it("keeps a working CLI login", () => {
    const decision = decide({ source: "cli", facts: facts(CLI) });

    expect(decision.target).toBe("cli");
    expect(decision.changed).toBe(false);
    expect(decision.notices).toEqual([]);
  });

  it("drops a stored app source whose authorization went away", () => {
    const decision = decide({
      source: "app",
      facts: facts({ appConfigured: true, appAuthorized: false }),
    });

    expect(decision.target).toBe("");
    expect(decision.notices.map((notice) => notice.code)).toEqual(["app-not-usable"]);
  });

  it("drops a stored app source when the instance no longer has an app", () => {
    const decision = decide({ source: "app", facts: facts() });

    expect(decision.target).toBe("");
    expect(decision.notices.map((notice) => notice.code)).toEqual(["app-not-configured"]);
  });

  it("asks for an installation when the app is authorized but reaches nothing", () => {
    const decision = decide({
      source: "",
      facts: facts({ appConfigured: true, appAuthorized: true, appInstallation: false }),
    });

    expect(decision.target).toBe("");
    expect(decision.notices.map((notice) => notice.code)).toEqual(["install-app"]);
  });
});

// ─── An instance that offers one source ──────────────────────────────────────

describe("an instance that offers only the app", () => {
  const method = "app" as const;

  it("uses the app and removes a CLI login found beside it", () => {
    const decision = decide({ method, source: "cli", facts: facts({ ...APP_READY, ...CLI }) });

    expect(decision.target).toBe("app");
    expect(decision.changed).toBe(true);
    expect(decision.notices).toEqual([
      { level: "warning", code: "removed-cli", login: "octocat" },
      { level: "info", code: "adopted-app" },
    ]);
  });

  it("leaves the account unlinked rather than accepting the CLI login", () => {
    const decision = decide({
      method,
      source: "cli",
      facts: facts({ appConfigured: true, ...CLI }),
    });

    expect(decision.target).toBe("");
    expect(decision.changed).toBe(true);
    expect(decision.notices.map((notice) => notice.code)).toEqual(["removed-cli"]);
  });

  it("does not tear a working CLI login down when no app is saved", () => {
    const decision = decide({ method, source: "cli", facts: facts(CLI) });

    expect(decision.target).toBe("cli");
    expect(decision.changed).toBe(false);
    // The misconfiguration is reported, and the permissive rules applied.
    expect(decision.notices.map((notice) => notice.code)).toEqual(["app-not-configured"]);
  });
});

describe("an instance that offers only the CLI", () => {
  const method = "cli" as const;

  it("takes over the CLI login and ignores the app", () => {
    const decision = decide({ method, source: "", facts: facts({ ...APP_READY, ...CLI }) });

    expect(decision.target).toBe("cli");
    expect(decision.notices.map((notice) => notice.code)).toEqual(["adopted-cli"]);
  });

  it("tells an app account why it was unlinked", () => {
    const decision = decide({ method, source: "app", facts: facts(APP_READY) });

    expect(decision.target).toBe("");
    expect(decision.changed).toBe(true);
    expect(decision.notices.map((notice) => notice.code)).toEqual(["app-not-offered"]);
  });
});

// ─── The invariant ───────────────────────────────────────────────────────────

describe("exactly one source", () => {
  const methods = ["choice", "app", "cli"] as const;
  const sources = ["", "app", "cli"] as const;
  const workspace: Partial<GithubSourceFacts>[] = [
    {},
    CLI,
    APP_READY,
    { ...APP_READY, ...CLI },
    { appConfigured: true, appAuthorized: true },
    { appConfigured: true },
    { cli: { login: null } },
  ];

  it("never keeps two sources at once, whatever is lying around", () => {
    for (const method of methods) {
      for (const source of sources) {
        for (const overrides of workspace) {
          const decision = decide({ method, source, facts: facts(overrides) });
          const label = `${method}/${source || "none"}/${JSON.stringify(overrides)}`;

          // A single value, and never one the instance does not offer.
          expect(["", "app", "cli"], label).toContain(decision.target);
          if (method === "app" && overrides.appConfigured)
            expect(decision.target, label).not.toBe("cli");
          if (method === "cli") expect(decision.target, label).not.toBe("app");

          // Changed means exactly "the stored value has to be rewritten".
          expect(decision.changed, label).toBe(decision.target !== source);

          // Every notice is a known code, and appears once.
          const seen = decision.notices.map((notice) => notice.code);
          expect(new Set(seen).size, label).toBe(seen.length);
          for (const code of seen) {
            expect(
              [
                "adopted-cli",
                "adopted-app",
                "removed-cli",
                "cli-gone",
                "install-app",
                "app-not-configured",
                "app-not-offered",
                "app-not-usable",
              ] satisfies GithubSourceNoticeCode[],
              label,
            ).toContain(code);
          }
        }
      }
    }
  });

  it("always reports a warning when it removes something", () => {
    for (const method of methods) {
      for (const source of sources) {
        for (const overrides of workspace) {
          const decision = decide({ method, source, facts: facts(overrides) });
          const removed = codes({ method, source, facts: facts(overrides) }).includes(
            "removed-cli",
          );
          if (!removed) continue;

          const notice = decision.notices.find((entry) => entry.code === "removed-cli");
          expect(notice?.level).toBe("warning");
        }
      }
    }
  });
});
