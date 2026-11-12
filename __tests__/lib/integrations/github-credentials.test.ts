import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCredentialHelper } from "@/lib/coder/gitconfig";
import {
  GITHUB_CREDENTIAL_FILE,
  GITHUB_HELPER_FILE,
  applyGithubHelper,
  credentialPolicyFor,
  githubGhShimScript,
  githubHelperCommand,
  githubHelperScript,
} from "@/lib/integrations/github-credentials";
import { GITHUB_HOST_URL } from "@/lib/integrations/github";
import { userIdentity } from "@/lib/sandbox/identity";

const USER = "user-1";
const SUBSECTION = "https://github.com";

/** The `[credential "https://github.com"]` subsection the tests write. */
const HEADER = `[credential "${SUBSECTION}"]`;

/** What `gh auth setup-git` leaves behind. */
const GH_HELPER = "\thelper = !/usr/bin/gh auth git-credential";

// ─── The file transformation ─────────────────────────────────────────────────

describe("withCredentialHelper", () => {
  it("adds the subsection to a config that has none", () => {
    const body = withCredentialHelper(
      "[user]\n\tname = Ada\n",
      SUBSECTION,
      "!/w/.local/bin/helper",
    );

    expect(body).toBe(
      ["[user]", "\tname = Ada", HEADER, "\thelper = !/w/.local/bin/helper", ""].join("\n"),
    );
  });

  it("replaces the helper the GitHub CLI installed", () => {
    const existing = ["[user]", "\tname = Ada", HEADER, GH_HELPER, ""].join("\n");

    const body = withCredentialHelper(existing, SUBSECTION, "!/w/.local/bin/helper");

    expect(body).toContain("\thelper = !/w/.local/bin/helper");
    expect(body).not.toContain("gh auth git-credential");
    // The rest of the file is the user's.
    expect(body).toContain("name = Ada");
  });

  it("removes every helper in the subsection when nothing should be active", () => {
    const existing = [HEADER, GH_HELPER, "\thelper = !/w/.local/bin/helper", ""].join("\n");

    const body = withCredentialHelper(existing, SUBSECTION, null);

    expect(body).not.toContain("helper =");
    // The subsection itself stays: another entry may be added to it later.
    expect(body).toContain(HEADER);
  });

  it("leaves another host and a bare credential section alone", () => {
    const existing = [
      "[credential]",
      "\thelper = !/usr/bin/my-helper",
      '[credential "https://gist.github.com"]',
      "\thelper = !/usr/bin/gh auth git-credential",
      "",
    ].join("\n");

    const body = withCredentialHelper(existing, SUBSECTION, "!/w/.local/bin/helper");

    expect(body).toContain("\thelper = !/usr/bin/my-helper");
    expect(body).toContain("\thelper = !/usr/bin/gh auth git-credential");
    // Our subsection was appended, the others untouched.
    expect(body.split(HEADER).length - 1).toBe(1);
  });

  it("is idempotent", () => {
    const once = withCredentialHelper("[user]\n\tname = Ada\n", SUBSECTION, "!/w/h");
    const twice = withCredentialHelper(once, SUBSECTION, "!/w/h");

    expect(twice).toBe(once);
  });

  it("keeps a subsection that already matches byte-identical", () => {
    const existing = [HEADER, "\thelper = !/w/h", ""].join("\n");

    expect(withCredentialHelper(existing, SUBSECTION, "!/w/h")).toBe(existing);
  });
});

// ─── The workspace ──────────────────────────────────────────────────────────

describe("applyGithubHelper", () => {
  let dir: string;
  const originalDir = process.env.SANDBOX_WORKSPACES_DIR;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-github-helper-"));
    process.env.SANDBOX_WORKSPACES_DIR = dir;
  });

  afterEach(async () => {
    process.env.SANDBOX_WORKSPACES_DIR = originalDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const configPath = () => path.join(dir, userIdentity(USER), ".gitconfig");

  it("points git at the app's helper when the app is the source", async () => {
    await applyGithubHelper(USER, "app");

    const body = await fs.readFile(configPath(), "utf8");
    expect(body).toContain(`[credential "${GITHUB_HOST_URL}"]`);
    expect(body).toContain(`\thelper = ${githubHelperCommand(USER)}`);
    expect(body).toContain(GITHUB_HELPER_FILE);
  });

  it("takes the app's helper away when the CLI owns the credential", async () => {
    await applyGithubHelper(USER, "app");
    await applyGithubHelper(USER, "cli");

    const body = await fs.readFile(configPath(), "utf8");
    expect(body).not.toContain(githubHelperCommand(USER));
    expect(body).not.toContain("helper =");
  });

  it("writes nothing when the source is not the app and there is no config", async () => {
    await applyGithubHelper(USER, "cli");

    await expect(fs.readFile(configPath(), "utf8")).rejects.toThrow();
  });

  it("leaves a matching config untouched", async () => {
    await applyGithubHelper(USER, "app");
    const before = await fs.stat(configPath());

    await applyGithubHelper(USER, "app");

    const after = await fs.stat(configPath());
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps a third-party helper out of the way while the app is active", async () => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(
      configPath(),
      [
        "[user]",
        "\tname = Ada",
        `[credential "${GITHUB_HOST_URL}"]`,
        "\thelper = !/usr/bin/gh auth git-credential",
        "",
      ].join("\n"),
    );

    await applyGithubHelper(USER, "app");

    const body = await fs.readFile(configPath(), "utf8");
    expect(body.match(/helper =/g)).toHaveLength(1);
    expect(body).toContain(githubHelperCommand(USER));
  });

  it("knows where the app's credential file goes", () => {
    expect(GITHUB_CREDENTIAL_FILE).toBe(".saale/github.json");
    expect(GITHUB_HELPER_FILE).toBe(".local/bin/saale-git-credential");
  });
});

// ─── The helper script itself ───────────────────────────────────────────────

describe("githubHelperScript", () => {
  let dir: string;
  const originalDir = process.env.SANDBOX_WORKSPACES_DIR;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-github-script-"));
    process.env.SANDBOX_WORKSPACES_DIR = dir;
  });

  afterEach(async () => {
    process.env.SANDBOX_WORKSPACES_DIR = originalDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Write the script and the token file where the workspace would carry them. */
  async function install(token: string | null): Promise<string> {
    const root = path.join(dir, userIdentity(USER));
    const script = path.join(root, GITHUB_HELPER_FILE);
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.mkdir(path.dirname(path.join(root, GITHUB_CREDENTIAL_FILE)), { recursive: true });
    await fs.writeFile(script, githubHelperScript(USER));
    if (token) {
      await fs.writeFile(path.join(root, GITHUB_CREDENTIAL_FILE), JSON.stringify({ token }));
    }
    return script;
  }

  const ask = (script: string) =>
    execFileSync("sh", [script, "get"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });

  it("answers git with the token it finds", async () => {
    const script = await install("ghs_installation_token");

    const answer = ask(script);

    expect(answer).toContain("username=x-access-token");
    expect(answer).toContain("password=ghs_installation_token");
  });

  it("prefers a token from the environment over the file", async () => {
    // That is the per-chat token: the environment of one command, not the
    // workspace-wide file.
    const script = await install("ghs_workspace");

    const answer = execFileSync("sh", [script, "get"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "ghs_one_chat" },
    });

    expect(answer).toContain("password=ghs_one_chat");
    expect(answer).not.toContain("ghs_workspace");
  });

  it("gives the agent's own gh the app's token", async () => {
    const root = path.join(dir, userIdentity(USER));
    const shim = githubGhShimScript(USER);

    // The shim is what makes `gh pr create` behave for a command the model runs
    // itself: in app mode the CLI has been signed out of the workspace.
    expect(shim).toContain(`"${path.join(root, GITHUB_CREDENTIAL_FILE)}"`);
    expect(shim).toContain("export GH_TOKEN");
    // A chat with no GitHub credential carries this: both readers of the token
    // file refuse on their own, not only because git's helper list is reset.
    expect(shim).toContain("SAALE_NO_GITHUB_CREDENTIAL");
    expect(shim).toContain("exit 1");

    const helper = githubHelperScript(USER);
    expect(helper).toContain("SAALE_NO_GITHUB_CREDENTIAL");
    // The message names no cause: the variable is set for three different ones.
    expect(shim).toContain("carries no GitHub credential");
    expect(helper).toContain("carries no GitHub credential");
    expect(shim).toContain("exec /usr/bin/gh");
  });

  it("hands the request to the GitHub CLI when there is no token", async () => {
    const script = await install(null);
    const body = await fs.readFile(script, "utf8");

    // Asserted structurally: whether gh answers depends on the machine the test
    // runs on, and a build host may well be logged in. What matters is that the
    // helper delegates instead of failing, so a stale token degrades to the CLI.
    expect(body).toContain("exec /usr/bin/gh auth git-credential");
    // The one early exit is the refusal for a chat that may not use GitHub at
    // all; without that variable the script always ends up at the CLI.
    expect(body.split("exit 1").length - 1).toBe(1);
    expect(body.indexOf("SAALE_NO_GITHUB_CREDENTIAL")).toBeLessThan(
      body.indexOf("exec /usr/bin/gh auth git-credential"),
    );
  });
});

// ─── One credential per command ─────────────────────────────────────────────

describe("credentialPolicyFor", () => {
  it("delivers the app's token and drops the account's own", () => {
    expect(credentialPolicyFor("app", "app")).toEqual({
      injectAppToken: true,
      stripUserToken: true,
    });
  });

  it("leaves the account's own token alone when the instance says it wins", () => {
    expect(credentialPolicyFor("app", "variable")).toEqual({
      injectAppToken: false,
      stripUserToken: false,
    });
  });

  it("has no opinion while the CLI is the source", () => {
    for (const precedence of ["app", "variable"] as const) {
      expect(credentialPolicyFor("cli", precedence)).toEqual({
        injectAppToken: false,
        stripUserToken: false,
      });
      expect(credentialPolicyFor("", precedence)).toEqual({
        injectAppToken: false,
        stripUserToken: false,
      });
    }
  });

  it("never asks for both at once", () => {
    for (const source of ["app", "cli", ""] as const) {
      for (const precedence of ["app", "variable"] as const) {
        const policy = credentialPolicyFor(source, precedence);
        // The account's token is only taken away when the app's token replaces
        // it — stripping without delivering would leave a command with none.
        expect(policy.stripUserToken && !policy.injectAppToken).toBe(false);
      }
    }
  });
});
