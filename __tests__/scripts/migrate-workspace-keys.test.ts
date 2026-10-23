import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveUserWorkspaceKey,
  USER_WORKSPACE_KEY_LENGTH,
  userIdentity,
} from "@/lib/sandbox/identity";
import {
  classify,
  KEY_LENGTH,
  migrate,
  workspaceKey,
} from "../../scripts/migrate-workspace-keys.mjs";

/**
 * The deploy that shortens workspace directories.
 *
 * Two things have to hold: the script derives the same key the app does (or
 * every user would be handed an empty workspace), and it only ever moves a
 * directory it can name the target for.
 */

/** What a user id looked like before the keys: 32 alphanumeric characters. */
const LEGACY_ID = "yy7vfya8Gg33Y5ROHdK2WhRRKvGqs5NA";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-migrate-keys-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function entryNames(): Promise<string[]> {
  return (await fs.readdir(root)).sort();
}

async function seed(name: string, files: Record<string, string> = {}): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content);
  }
}

describe("workspaceKey", () => {
  it("is the key the app derives, for every id", () => {
    for (const id of [LEGACY_ID, "user-1", "clx3j7k9l0000abcd1234efgh", "ünïcode"]) {
      expect(workspaceKey(id)).toBe(deriveUserWorkspaceKey(id));
      expect(`user-${workspaceKey(id)}`).toBe(userIdentity(id));
    }
    expect(KEY_LENGTH).toBe(USER_WORKSPACE_KEY_LENGTH);
  });
});

describe("classify", () => {
  it("renames a legacy directory to the derived key", () => {
    expect(classify(`user-${LEGACY_ID}`)).toEqual({
      action: "rename",
      from: `user-${LEGACY_ID}`,
      to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}`,
    });
  });

  it("leaves a directory that already carries a key", () => {
    expect(classify(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`)).toMatchObject({
      action: "skip",
      reason: "already migrated",
    });
  });

  it("leaves everything that is not a user's directory", () => {
    expect(classify("council-3bd99582")).toMatchObject({ action: "skip" });
    expect(classify("lost+found")).toMatchObject({ action: "skip" });
    expect(classify("user-short")).toMatchObject({ action: "unknown" });
  });
});

describe("migrate", () => {
  it("moves the legacy directory and keeps what is in it", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });
    await seed("council-3bd99582", { "brief.md": "council work" });

    const result = await migrate(root, { log: () => {} });

    expect(result.renamed).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(await entryNames()).toEqual([
      "council-3bd99582",
      `user-${deriveUserWorkspaceKey(LEGACY_ID)}`,
    ]);
    const moved = path.join(root, `user-${deriveUserWorkspaceKey(LEGACY_ID)}`, "notes.md");
    expect(await fs.readFile(moved, "utf8")).toBe("keep me");
  });

  it("is idempotent: a second run moves nothing", async () => {
    await seed(`user-${LEGACY_ID}`);

    await migrate(root, { log: () => {} });
    const second = await migrate(root, { log: () => {} });

    expect(second.renamed).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  it("does not touch anything on a dry run", async () => {
    await seed(`user-${LEGACY_ID}`);

    const result = await migrate(root, { dryRun: true, log: () => {} });

    expect(result.renamed).toHaveLength(1);
    expect(await entryNames()).toEqual([`user-${LEGACY_ID}`]);
  });

  it("refuses to merge two directories into one", async () => {
    await seed(`user-${LEGACY_ID}`, { "old.md": "old" });
    await seed(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`, { "new.md": "new" });

    const result = await migrate(root, { log: () => {} });

    expect(result.renamed).toEqual([]);
    expect(result.conflicts).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(await fs.readFile(path.join(root, `user-${LEGACY_ID}`, "old.md"), "utf8")).toBe("old");
  });
});
