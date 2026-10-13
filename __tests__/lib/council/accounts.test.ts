import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ configured: true }));

vi.mock("@/lib/db", () => ({
  prisma: { council: { findMany: vi.fn(async () => []) } },
}));

// The mapping itself belongs to the terminal client and is exercised against a
// real container by the sandbox tests; here it only has to be invertible.
vi.mock("@/lib/terminal/client", () => ({
  isConfigured: () => hoisted.configured,
  deriveOpenTerminalUsername: (id: string) => `acct${id}`,
  getTerminalHomeDir: (id: string) => `/home/acct${id}`,
}));

vi.mock("@/lib/council/commands", () => ({
  containerAccountExists: vi.fn(async () => false),
}));

import { prisma } from "@/lib/db";
import { containerAccountExists } from "@/lib/council/commands";
import { allocateSandboxKey, deriveSandboxKey, sandboxIdentity } from "@/lib/council/accounts";
import { SANDBOX_KEY_LENGTH } from "@/lib/council/config";

const findMany = vi.mocked(prisma.council.findMany);
const accountExists = vi.mocked(containerAccountExists);

const COUNCIL = "council_abc";
const USER = "user_123";

describe("deriveSandboxKey", () => {
  it("is a key the container keeps in full", () => {
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

  it("does not hand a council the user's own account name for a known id", () => {
    // The property that matters: keys are uncorrelated with the user id, so a
    // council's account is never the user's account.
    const key = deriveSandboxKey(COUNCIL, USER);
    expect(key).not.toContain("user");
  });
});

describe("sandboxIdentity", () => {
  it("maps the key to the account and home the container derives from it", () => {
    expect(sandboxIdentity("abcd1234")).toEqual({
      key: "abcd1234",
      account: "acctabcd1234",
      home: "/home/acctabcd1234",
    });
  });
});

describe("allocateSandboxKey", () => {
  beforeEach(() => {
    hoisted.configured = true;
    findMany.mockResolvedValue([] as never);
    accountExists.mockResolvedValue(false);
  });

  it("takes the first attempt when nothing holds it", async () => {
    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER));
    expect(accountExists).toHaveBeenCalledWith(`acct${key}`);
  });

  it("steps aside from a key another council already stored", async () => {
    const taken = deriveSandboxKey(COUNCIL, USER);
    findMany.mockResolvedValue([{ sandboxKey: taken }] as never);

    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).not.toBe(taken);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER, 1));
  });

  it("steps aside when the container already has the account", async () => {
    // The account may belong to the user, or to something else in the container:
    // either way the council must not land in it.
    accountExists.mockResolvedValueOnce(true).mockResolvedValue(false);

    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER, 1));
    expect(accountExists).toHaveBeenCalledTimes(2);
  });

  it("skips the container probe when no terminal is configured", async () => {
    hoisted.configured = false;
    const key = await allocateSandboxKey(USER, COUNCIL);
    expect(key).toBe(deriveSandboxKey(COUNCIL, USER));
    expect(accountExists).not.toHaveBeenCalled();
  });

  it("fails loudly instead of reusing a key it could not free", async () => {
    accountExists.mockResolvedValue(true);
    await expect(allocateSandboxKey(USER, COUNCIL)).rejects.toThrow(/No free council sandbox key/);
  });
});
