import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCredentialHelper } from "@/lib/coder/gitconfig";
import {
  GITHUB_CREDENTIAL_FILE,
  GITHUB_HELPER_FILE,
  GITHUB_HOST_URL,
  applyGithubHelper,
  githubHelperCommand,
} from "@/lib/integrations/github-credentials";
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
