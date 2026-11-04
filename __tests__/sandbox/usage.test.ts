import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listWorkspaceIdentities, measureWorkspaceUsage, parseDuLine } from "@/lib/sandbox/usage";

const KIB = 1024;

describe("parseDuLine", () => {
  it("reads the size in KiB and the path it counted", () => {
    expect(parseDuLine(`2048\t/w/user-abc123`)).toEqual({
      bytes: 2048 * KIB,
      path: "/w/user-abc123",
    });
  });

  it("keeps a path that holds a space whole", () => {
    expect(parseDuLine("12 /w/user-an odd name")).toEqual({
      bytes: 12 * KIB,
      path: "/w/user-an odd name",
    });
  });

  it("ignores a line that is not a measurement", () => {
    expect(parseDuLine("du: cannot access '/w/gone'")).toBeNull();
    expect(parseDuLine("")).toBeNull();
  });
});

describe("workspace measurement", () => {
  let volume: string;

  beforeEach(async () => {
    volume = await fs.mkdtemp(path.join(os.tmpdir(), "saale-usage-"));
  });

  afterEach(async () => {
    await fs.rm(volume, { recursive: true, force: true });
  });

  it("lists the directories that name a workspace and nothing else", async () => {
    await fs.mkdir(path.join(volume, "user-abc123"));
    await fs.mkdir(path.join(volume, "user-7f3a91bc"));
    await fs.mkdir(path.join(volume, "user-not.an.identity"));
    await fs.mkdir(path.join(volume, "shared-7f3a91bc"));
    await fs.writeFile(path.join(volume, "stray-file"), "x");
    await fs.mkdir(path.join(volume, ".lost+found"));

    // Only `user-` names a workspace; anything else is left to a human.
    expect(await listWorkspaceIdentities(volume)).toEqual(["user-7f3a91bc", "user-abc123"]);
  });

  it("answers nothing for a volume that is not mounted", async () => {
    expect(await listWorkspaceIdentities(path.join(volume, "missing"))).toEqual([]);
  });

  it("measures each identity, and reports a file's bytes as its size", async () => {
    const user = path.join(volume, "user-abc123");
    const other = path.join(volume, "user-7f3a91bc");
    const empty = path.join(volume, "user-000000000000");
    await fs.mkdir(user, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(user, "a.bin"), Buffer.alloc(200 * KIB));
    await fs.mkdir(path.join(user, "nested"));
    await fs.writeFile(path.join(user, "nested", "b.bin"), Buffer.alloc(50 * KIB));
    await fs.writeFile(path.join(other, "c.bin"), Buffer.alloc(7 * KIB));

    const usage = await measureWorkspaceUsage(volume, [
      "user-abc123",
      "user-7f3a91bc",
      "user-000000000000",
    ]);

    const byIdentity = new Map(usage.map((row) => [row.identity, row.bytes]));
    expect(byIdentity.get("user-abc123")).toBeGreaterThanOrEqual(250 * KIB);
    expect(byIdentity.get("user-7f3a91bc")).toBeGreaterThanOrEqual(7 * KIB);
    // An empty workspace still has a row: du counts the directory itself.
    expect(byIdentity.get("user-000000000000")).toBeLessThan(64 * KIB);
  });

  it("leaves out an identity whose directory vanished", async () => {
    await fs.mkdir(path.join(volume, "user-abc123"));

    const usage = await measureWorkspaceUsage(volume, ["user-abc123", "user-ffffffffffff"]);

    expect(usage.map((row) => row.identity)).toEqual(["user-abc123"]);
  });
});
