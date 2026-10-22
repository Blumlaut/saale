import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
  evict: vi.fn(async () => 1),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    sandboxEnvVar: {
      findMany: hoisted.findMany,
      upsert: hoisted.upsert,
      deleteMany: hoisted.deleteMany,
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: hoisted.encrypt,
  decrypt: hoisted.decrypt,
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: hoisted.evict,
}));

import {
  deleteSandboxEnvVar,
  isValidEnvName,
  listSandboxEnvNames,
  requireEnvName,
  resolveSandboxEnv,
  SandboxEnvError,
  setSandboxEnvVar,
} from "@/lib/sandbox/env";

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.findMany.mockResolvedValue([]);
  hoisted.deleteMany.mockResolvedValue({ count: 1 });
});

describe("name rules", () => {
  it("accepts the names a shell and an agent use", () => {
    for (const name of ["GH_TOKEN", "NPM_CONFIG_TOKEN", "_PRIVATE", "A", "X".repeat(64)]) {
      expect(isValidEnvName(name)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const name of [
      "gh_token",
      "1TOKEN",
      "WITH-DASH",
      "WITH SPACE",
      "",
      "X".repeat(65),
      "A=B",
    ]) {
      expect(isValidEnvName(name)).toBe(false);
      expect(() => requireEnvName(name)).toThrow(SandboxEnvError);
    }
  });

  it("refuses a value the exec could not carry", () => {
    expect(() => requireEnvName(42)).toThrow(SandboxEnvError);
  });
});

describe("resolveSandboxEnv", () => {
  it("returns the decrypted values of this user's rows", async () => {
    hoisted.findMany.mockResolvedValue([
      { name: "GH_TOKEN", encryptedValue: "enc:ghp_secret" },
      { name: "NPM_TOKEN", encryptedValue: "enc:npm_secret" },
    ]);

    await expect(resolveSandboxEnv("user-1")).resolves.toEqual({
      GH_TOKEN: "ghp_secret",
      NPM_TOKEN: "npm_secret",
    });
    expect(hoisted.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { name: true, encryptedValue: true },
    });
  });

  it("scopes the read to one user, so another user's values cannot arrive", async () => {
    await resolveSandboxEnv("user-1");
    expect(hoisted.findMany.mock.calls[0]![0].where).toEqual({ userId: "user-1" });

    await resolveSandboxEnv("user-2");
    expect(hoisted.findMany.mock.calls[1]![0].where).toEqual({ userId: "user-2" });
  });

  it("skips a row that will not decrypt instead of failing every command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.decrypt
      .mockImplementationOnce(() => {
        throw new Error("bad auth tag");
      })
      .mockImplementationOnce((value: string) => value.replace(/^enc:/, ""));
    hoisted.findMany.mockResolvedValue([
      { name: "BROKEN", encryptedValue: "enc:x" },
      { name: "GH_TOKEN", encryptedValue: "enc:ok" },
    ]);

    await expect(resolveSandboxEnv("user-1")).resolves.toEqual({ GH_TOKEN: "ok" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("BROKEN"), expect.anything());
    error.mockRestore();
  });
});

describe("listSandboxEnvNames", () => {
  it("returns names, sorted, and never a value", async () => {
    hoisted.findMany.mockResolvedValue([{ name: "GH_TOKEN" }, { name: "AWS_KEY" }]);

    const names = await listSandboxEnvNames("user-1");

    expect(names).toEqual(["GH_TOKEN", "AWS_KEY"]);
    expect(hoisted.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { name: true },
      orderBy: { name: "asc" },
    });
  });
});

describe("setSandboxEnvVar", () => {
  it("stores the value encrypted and rebuilds the user's sessions", async () => {
    await setSandboxEnvVar("user-1", "GH_TOKEN", "ghp_secret");

    expect(hoisted.encrypt).toHaveBeenCalledWith("ghp_secret");
    expect(hoisted.upsert).toHaveBeenCalledWith({
      where: { userId_name: { userId: "user-1", name: "GH_TOKEN" } },
      create: { userId: "user-1", name: "GH_TOKEN", encryptedValue: "enc:ghp_secret" },
      update: { encryptedValue: "enc:ghp_secret" },
    });
    expect(hoisted.evict).toHaveBeenCalledWith("user-1");
  });

  it("refuses an invalid name before touching the database", async () => {
    await expect(setSandboxEnvVar("user-1", "gh token", "x")).rejects.toThrow(SandboxEnvError);
    expect(hoisted.upsert).not.toHaveBeenCalled();
  });

  it("refuses a NUL byte in a value", async () => {
    await expect(setSandboxEnvVar("user-1", "GH_TOKEN", "a\0b")).rejects.toThrow(/NUL/);
  });

  it("caps the count at 32 variables", async () => {
    hoisted.findMany.mockResolvedValue(
      Array.from({ length: 32 }, (_, i) => ({ name: `V_${i}`, encryptedValue: "enc:x" })),
    );

    await expect(setSandboxEnvVar("user-1", "ONE_MORE", "x")).rejects.toThrow(/At most 32/);
  });

  it("caps the total size of the values", async () => {
    hoisted.findMany.mockResolvedValue([
      { name: "BIG", encryptedValue: `enc:${"x".repeat(20 * 1024)}` },
    ]);

    await expect(setSandboxEnvVar("user-1", "ANOTHER", "y".repeat(20 * 1024))).rejects.toThrow(
      /cannot exceed/,
    );
  });

  it("lets an existing name be replaced without counting twice", async () => {
    hoisted.findMany.mockResolvedValue(
      Array.from({ length: 32 }, (_, i) => ({ name: `V_${i}`, encryptedValue: "enc:x" })),
    );

    await expect(setSandboxEnvVar("user-1", "V_3", "new value")).resolves.toBeUndefined();
  });
});

describe("deleteSandboxEnvVar", () => {
  it("deletes one row of this user and rebuilds the sessions", async () => {
    await expect(deleteSandboxEnvVar("user-1", "GH_TOKEN")).resolves.toBe(true);

    expect(hoisted.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", name: "GH_TOKEN" },
    });
    expect(hoisted.evict).toHaveBeenCalledWith("user-1");
  });

  it("does not rebuild sessions for a name that was not set", async () => {
    hoisted.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteSandboxEnvVar("user-1", "GH_TOKEN")).resolves.toBe(false);
    expect(hoisted.evict).not.toHaveBeenCalled();
  });
});
