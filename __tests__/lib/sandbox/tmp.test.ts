import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepWorkspaceTmp } from "@/lib/sandbox/tmp";

const HOUR = 3_600_000;
const AT = Date.parse("2026-06-01T12:00:00Z");

let volume: string;

beforeAll(async () => {
  volume = await fs.mkdtemp(path.join(os.tmpdir(), "saale-tmp-sweep-"));
});

afterAll(async () => {
  await fs.rm(volume, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const entry of await fs.readdir(volume)) {
    await fs.rm(path.join(volume, entry), { recursive: true, force: true });
  }
});

/** A scratch entry with a chosen age, in the identity's own workspace. */
async function scratch(identity: string, name: string, ageHours: number): Promise<string> {
  const tmp = path.join(volume, identity, ".tmp");
  await fs.mkdir(tmp, { recursive: true });
  const target = path.join(tmp, name);
  await fs.writeFile(target, "scratch");
  const when = new Date(AT - ageHours * HOUR);
  await fs.utimes(target, when, when);
  return target;
}

describe("sweepWorkspaceTmp", () => {
  it("removes entries older than the age and keeps the rest", async () => {
    const stale = await scratch("user-a", "old.png", 100);
    const fresh = await scratch("user-a", "new.png", 2);

    const result = await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    expect(result).toEqual({ removed: 1, workspaces: 1 });
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("removes a whole stale directory, leaving the scratch directory itself", async () => {
    const dir = path.join(volume, "user-a", ".tmp", "npm");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cache"), "x");
    const when = new Date(AT - 100 * HOUR);
    await fs.utimes(path.join(dir, "cache"), when, when);
    await fs.utimes(dir, when, when);

    await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    await expect(fs.stat(dir)).rejects.toThrow();
    expect((await fs.stat(path.join(volume, "user-a", ".tmp"))).isDirectory()).toBe(true);
  });

  it("keeps a stale directory that wraps a fresh nested file", async () => {
    // The folder is old but a run wrote into it an hour ago; its mtime does not
    // reflect that, so the age has to be checked down the tree.
    const dir = path.join(volume, "user-a", ".tmp", "shots");
    const fresh = path.join(dir, "runs", "new-run", "preview.png");
    const oldRun = path.join(dir, "runs", "old-run");
    await fs.mkdir(path.dirname(fresh), { recursive: true });
    await fs.mkdir(oldRun, { recursive: true });
    await fs.writeFile(fresh, "fresh bytes");
    await fs.writeFile(path.join(oldRun, "preview.png"), "stale bytes");
    const stale = new Date(AT - 100 * HOUR);
    await fs.utimes(dir, stale, stale);
    await fs.utimes(path.join(dir, "runs"), stale, stale);
    await fs.utimes(oldRun, stale, stale);
    await fs.utimes(path.join(oldRun, "preview.png"), stale, stale);

    const result = await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    expect(result.removed).toBe(0);
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("removes a stale directory whose deepest files are stale too", async () => {
    const dir = path.join(volume, "user-a", ".tmp", "npm");
    const deep = path.join(dir, "cache", "sub");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, "blob"), "x");
    const stale = new Date(AT - 100 * HOUR);
    for (const target of [deep, path.join(dir, "cache"), dir, path.join(deep, "blob")]) {
      await fs.utimes(target, stale, stale);
    }

    const result = await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    expect(result.removed).toBe(1);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("leaves workspaces that never used a scratch directory alone", async () => {
    await fs.mkdir(path.join(volume, "user-b"), { recursive: true });
    await fs.writeFile(path.join(volume, "user-b", "keep.txt"), "mine");

    const result = await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    expect(result).toEqual({ removed: 0, workspaces: 0 });
    await expect(fs.stat(path.join(volume, "user-b", "keep.txt"))).resolves.toBeDefined();
  });

  it("does nothing when the age is zero", async () => {
    const stale = await scratch("user-a", "old.png", 100);

    expect(await sweepWorkspaceTmp(volume, { olderThanMs: 0, at: AT })).toEqual({
      removed: 0,
      workspaces: 0,
    });
    await expect(fs.stat(stale)).resolves.toBeDefined();
  });

  it("sweeps every workspace in the volume", async () => {
    await scratch("user-a", "a.png", 100);
    await scratch("user-b", "b.png", 100);
    await scratch("user-b", "c.png", 1);

    const result = await sweepWorkspaceTmp(volume, { olderThanMs: 72 * HOUR, at: AT });

    expect(result).toEqual({ removed: 2, workspaces: 2 });
  });
});
