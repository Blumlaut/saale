import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { council: { findMany: vi.fn(async () => []) } },
}));

import { prisma } from "@/lib/db";
import { allocateSandboxKey, deriveSandboxKey, sandboxIdentity } from "@/lib/council/accounts";
import { SANDBOX_KEY_LENGTH } from "@/lib/council/config";

const findMany = vi.mocked(prisma.council.findMany);

const COUNCIL = "council_abc";
const USER = "user_123";

describe("deriveSandboxKey", () => {
  it("is a key that is safe as a directory name and a container label", () => {
    const key = deriveSandboxKey(COUNCIL, USER);
    expect(key).toHaveLength(SANDBOX_KEY_LENGTH);
    expect(key).toMatch(/^[a-f0-9]+$/);
  });

  it("is stable for a council and different per council, user and attempt", () => {
    expect(deriveSandboxKey(COUNCIL, USER)).toBe(deriveSandboxKey(COUNCIL, USER));
    expect(deriveSandboxKey(COUNCIL, USER)).not.toBe(deriveSandboxKey("council_other", USER));
    expect(deriveSandboxKey(COUNCIL, USER)).not.toBe(deriveSandboxKey(COUNCIL, "user_other"));
    expect(deriveSandboxKey(COUNCIL, USER)).not.toBe(deriveSandboxKey(COUNCIL, USER, 1));
  });
});

describe("sandboxIdentity", () => {
  it("maps the key to the identity, directory and container name", () => {
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
    expect(sandboxIdentity("abcd1234")).toEqual({
      key: "abcd1234",
      id: "council-abcd1234",
      path: "/workspaces/council-abcd1234",
    });
  });

  it("follows a deployment that mounts the volume elsewhere", () => {
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/srv/workspaces");
    expect(sandboxIdentity("abcd1234").path).toBe("/srv/workspaces/council-abcd1234");
  });
});

describe("allocateSandboxKey", () => {
  beforeEach(() => {
    findMany.mockResolvedValue([] as never);
  });

  it("takes the first attempt when nothing holds it", async () => {
    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER));
  });

  it("steps aside from a key another council already stored", async () => {
    const taken = deriveSandboxKey(COUNCIL, USER);
    findMany.mockResolvedValue([{ sandboxKey: taken }] as never);

    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).not.toBe(taken);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER, 1));
  });

  it("reads the stored keys instance-wide, since a key names a shared directory", async () => {
    await allocateSandboxKey(USER, COUNCIL);
    expect(findMany).toHaveBeenCalledWith({ select: { sandboxKey: true } });
  });

  it("fails loudly instead of reusing a key it could not free", async () => {
    const everyKey = Array.from({ length: 16 }, (_, attempt) => ({
      sandboxKey: deriveSandboxKey(COUNCIL, USER, attempt),
    }));
    findMany.mockResolvedValue(everyKey as never);

    await expect(allocateSandboxKey(USER, COUNCIL)).rejects.toThrow(/No free council sandbox key/);
  });
});
