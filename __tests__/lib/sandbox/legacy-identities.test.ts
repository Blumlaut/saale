import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveUserWorkspaceKey } from "@/lib/sandbox/identity";
import {
  legacyTargetName,
  migrateLegacyIdentities,
  migrateWorkspaceIdentitiesOnBoot,
} from "@/lib/sandbox/legacy-identities";

/**
 * The rename a deploy must not need an operator for.
 *
 * Two properties matter and both are tested here: the app finds the same
 * directory after the migration as before it, and running it from several
 * processes at once (web, worker, sandbox service) cannot split a user's files.
 */

/** What a user id looked like before the keys: 32 alphanumeric characters. */
const LEGACY_ID = "yy7vfya8Gg33Y5ROHdK2WhRRKvGqs5NA";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-legacy-identities-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

async function entryNames(): Promise<string[]> {
  return (await fs.readdir(root)).sort();
}

describe("legacyTargetName", () => {
  it("names a legacy directory by the key the app now derives", () => {
    expect(legacyTargetName(`user-${LEGACY_ID}`)).toBe(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`);
  });

  it("has nothing to do for a directory that already carries a key", () => {
    expect(legacyTargetName(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`)).toBeNull();
  });

  it("has nothing to do for anything that is not a user's directory", () => {
    expect(legacyTargetName("council-3bd99582")).toBeNull();
    expect(legacyTargetName("lost+found")).toBeNull();
    expect(legacyTargetName(`user-${LEGACY_ID}/x`)).toBeNull();
  });

  it("refuses to guess at a suffix that is not a user id", () => {
    expect(legacyTargetName("user-short")).toBeNull();
  });
});

describe("migrateLegacyIdentities", () => {
  it("moves the legacy directory and keeps what is in it", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });
    await seed("council-3bd99582", { "brief.md": "council work" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(await entryNames()).toEqual([
      "council-3bd99582",
      `user-${deriveUserWorkspaceKey(LEGACY_ID)}`,
    ]);
    const moved = path.join(root, `user-${deriveUserWorkspaceKey(LEGACY_ID)}`, "notes.md");
    expect(await fs.readFile(moved, "utf8")).toBe("keep me");
  });

  it("is idempotent: a second boot finds nothing to do", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    await migrateLegacyIdentities();
    const second = await migrateLegacyIdentities();

    expect(second).toEqual({ renamed: [], conflicts: [], unrecognised: [] });
    expect(await entryNames()).toEqual([`user-${deriveUserWorkspaceKey(LEGACY_ID)}`]);
  });

  it("survives three processes doing it at once", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    const reports = await Promise.all([
      migrateLegacyIdentities(),
      migrateLegacyIdentities(),
      migrateLegacyIdentities(),
    ]);

    expect(reports.flatMap((report) => report.renamed)).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(reports.flatMap((report) => report.conflicts)).toEqual([]);
    const moved = path.join(root, `user-${deriveUserWorkspaceKey(LEGACY_ID)}`, "notes.md");
    expect(await fs.readFile(moved, "utf8")).toBe("keep me");
  });

  it("refuses to merge two directories into one", async () => {
    const keyed = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    await seed(`user-${LEGACY_ID}`, { "old.md": "old" });
    await seed(keyed, { "new.md": "new" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([]);
    expect(report.conflicts).toEqual([{ from: `user-${LEGACY_ID}`, to: keyed }]);
    expect(await fs.readFile(path.join(root, `user-${LEGACY_ID}`, "old.md"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(root, keyed, "new.md"), "utf8")).toBe("new");
  });

  it("reports a user directory it cannot name, rather than moving it", async () => {
    await seed("user-short", { "notes.md": "unknown" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([]);
    expect(report.unrecognised).toEqual(["user-short"]);
    expect(await entryNames()).toEqual(["user-short"]);
  });

  it("does nothing when the volume is not mounted yet", async () => {
    await fs.rm(root, { recursive: true, force: true });

    expect(await migrateLegacyIdentities()).toEqual({
      renamed: [],
      conflicts: [],
      unrecognised: [],
    });
  });
});

describe("migrateWorkspaceIdentitiesOnBoot", () => {
  it("moves the directories and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    await migrateWorkspaceIdentitiesOnBoot("web");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[web] moved 1 workspace directory"));
    warn.mockRestore();
  });

  it("keeps a startup going when the volume cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.writeFile(root, "not a directory");

    await expect(migrateWorkspaceIdentitiesOnBoot("worker")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("[worker] workspace identity migration failed"),
      expect.anything(),
    );
    error.mockRestore();
  });
});
