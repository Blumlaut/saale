import { describe, it, expect, vi, beforeEach } from "vitest";

// A 32-byte key, set before the crypto module is imported.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import * as db from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { createProviderCredentialStore } from "@/lib/providers/credential-store";

/** One `provider_api_key` row, as the store reads it. */
function row(overrides: {
  provider: string;
  encryptedKey?: string;
  encryptedCredential?: string | null;
}) {
  return {
    provider: overrides.provider,
    encryptedKey: overrides.encryptedKey ?? encrypt(""),
    encryptedCredential: overrides.encryptedCredential ?? null,
  };
}

/** A user row plus a global row, which is the usual shape of a scope's data. */
function rowsFor(scope: "user" | "global", rows: ReturnType<typeof row>[]) {
  vi.mocked(db.prisma.providerApiKey.findMany).mockImplementation((async (args: {
    where: { userId: string | null };
  }) =>
    (scope === "user" && args.where.userId === null) || scope === "global" ? rows : []) as never);
}

describe("createProviderCredentialStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([] as never);
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.prisma.providerApiKey.upsert).mockResolvedValue({} as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({} as never);
    vi.mocked(db.prisma.providerApiKey.create).mockResolvedValue({} as never);
    vi.mocked(db.prisma.providerApiKey.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("reads a Pi credential, with the provider env it carries", async () => {
    const credential = {
      type: "api_key",
      key: "cf-key",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
    };
    rowsFor("user", [
      row({
        provider: "cloudflare-ai-gateway",
        encryptedCredential: encrypt(JSON.stringify(credential)),
      }),
    ]);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("cloudflare-ai-gateway")).resolves.toEqual(credential);
    // A store reads the scope's rows once, not once per provider.
    expect(db.prisma.providerApiKey.findMany).toHaveBeenCalledTimes(2);
  });

  it("reads an OAuth credential with the provider's own extra fields", async () => {
    const credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 1_800_000_000_000,
      clientId: "issued-client-id",
    };
    rowsFor("user", [
      row({ provider: "openai", encryptedCredential: encrypt(JSON.stringify(credential)) }),
    ]);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("openai")).resolves.toEqual(credential);
  });

  it("reads a key stored before credentials were JSON as an api-key credential", async () => {
    rowsFor("user", [row({ provider: "anthropic", encryptedKey: encrypt("sk-ant-existing") })]);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("anthropic")).resolves.toEqual({
      type: "api_key",
      key: "sk-ant-existing",
    });
  });

  it("inherits a global credential the user has not configured", async () => {
    // The user's own row is a different provider; the global row is shared.
    vi.mocked(db.prisma.providerApiKey.findMany).mockImplementation((async (args: {
      where: { userId: string | null };
    }) =>
      args.where.userId === null
        ? [row({ provider: "groq", encryptedKey: encrypt("global-groq") })]
        : [row({ provider: "anthropic", encryptedKey: encrypt("user-anthropic") })]) as never);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("groq")).resolves.toEqual({ type: "api_key", key: "global-groq" });
    await expect(store.read("anthropic")).resolves.toEqual({
      type: "api_key",
      key: "user-anthropic",
    });
  });

  it("lets the user's own credential override the global one", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany).mockImplementation((async (args: {
      where: { userId: string | null };
    }) =>
      args.where.userId === null
        ? [row({ provider: "groq", encryptedKey: encrypt("global-groq") })]
        : [row({ provider: "groq", encryptedKey: encrypt("user-groq") })]) as never);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("groq")).resolves.toEqual({ type: "api_key", key: "user-groq" });
  });

  it("stores a credential written through modify, encrypted", async () => {
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });
    const credential = { type: "api_key" as const, key: "gsk-new" };

    const stored = await store.modify("groq", async () => credential);

    expect(stored).toEqual(credential);
    const call = vi.mocked(db.prisma.providerApiKey.upsert).mock.calls[0]![0];
    expect(call.where).toEqual({ userId_provider: { userId: "user-1", provider: "groq" } });
    // Never the plaintext key: the column holds one ciphertext of the credential.
    expect(call.create.encryptedCredential).not.toContain("gsk-new");
    expect(JSON.parse(decrypt(call.create.encryptedCredential!))).toEqual(credential);
    // …and it is readable straight back, without another query.
    await expect(store.read("groq")).resolves.toEqual(credential);
  });

  it("leaves the entry unchanged when modify returns undefined", async () => {
    rowsFor("user", [row({ provider: "groq", encryptedKey: encrypt("gsk-existing") })]);
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    const stored = await store.modify("groq", async () => undefined);

    expect(stored).toEqual({ type: "api_key", key: "gsk-existing" });
    expect(db.prisma.providerApiKey.upsert).not.toHaveBeenCalled();
  });

  it("serializes concurrent writes to the same provider", async () => {
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });
    const order: string[] = [];

    await Promise.all([
      store.modify("groq", async () => {
        order.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("first:end");
        return { type: "api_key", key: "first" };
      }),
      store.modify("groq", async (current) => {
        order.push(`second:start:${current?.type === "api_key" ? "first" : "none"}`);
        return { type: "api_key", key: "second" };
      }),
    ]);

    // The second write saw the first one's credential, and neither interleaved.
    expect(order).toEqual(["first:start", "first:end", "second:start:first"]);
  });

  it("deletes the scope's row and forgets the credential", async () => {
    rowsFor("user", [row({ provider: "groq", encryptedKey: encrypt("gsk-existing") })]);
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await store.delete("groq");

    expect(db.prisma.providerApiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "groq" },
    });
    await expect(store.read("groq")).resolves.toBeUndefined();
  });

  it("writes the global scope's existing row instead of creating a second one", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue({ id: "global-row" } as never);
    const store = createProviderCredentialStore({ kind: "global" });

    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant" }));

    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "global-row" },
      data: { encryptedCredential: expect.any(String) },
    });
    expect(db.prisma.providerApiKey.create).not.toHaveBeenCalled();
  });

  it("creates the global row the first time a credential is stored", async () => {
    const store = createProviderCredentialStore({ kind: "global" });

    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant" }));

    expect(db.prisma.providerApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: null, provider: "anthropic" }),
    });
  });

  it("treats an unreadable credential as absent instead of throwing", async () => {
    rowsFor("user", [row({ provider: "groq", encryptedCredential: "not-a-ciphertext" })]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("groq")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to decrypt the credential for provider groq"),
      expect.anything(),
    );
    log.mockRestore();
  });

  it("treats a structurally invalid credential as absent", async () => {
    rowsFor("user", [
      row({ provider: "groq", encryptedCredential: encrypt(JSON.stringify({ key: "no type" })) }),
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.read("groq")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("is malformed; treating it as absent"),
    );
    log.mockRestore();
  });

  it("lists the stored credential types without their secrets", async () => {
    rowsFor("user", [
      row({ provider: "groq", encryptedKey: encrypt("gsk") }),
      row({
        provider: "anthropic",
        encryptedCredential: encrypt(
          JSON.stringify({
            type: "oauth",
            refresh: "r",
            access: "a",
            expires: 1_800_000_000_000,
          }),
        ),
      }),
      row({ provider: "custom" }),
    ]);

    const store = createProviderCredentialStore({ kind: "user", userId: "user-1" });

    await expect(store.list()).resolves.toEqual([
      { providerId: "groq", type: "api_key" },
      { providerId: "anthropic", type: "oauth" },
    ]);
  });
});
