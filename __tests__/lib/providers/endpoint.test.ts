import { describe, it, expect, vi, beforeEach } from "vitest";

// A 32-byte key, set before the crypto module is imported.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import * as db from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { readEndpointRow, readEndpointRows } from "@/lib/providers/endpoint";

/** One `provider_api_key` row, as the endpoint reader sees it. */
function row(provider: string, overrides: { label?: string; baseUrl?: string } = {}) {
  return {
    id: `key-${provider}`,
    userId: null,
    provider,
    label: overrides.label ?? "",
    baseUrl: overrides.baseUrl ?? `http://${provider}.test/v1`,
    encryptedKey: encrypt(""),
    contextWindow: null,
    maxOutputTokens: null,
    modelCapabilities: null,
  };
}

/** Serve `own` for the caller's rows and `global` for the admin's. */
function serve(own: ReturnType<typeof row>[], global: ReturnType<typeof row>[]) {
  vi.mocked(db.prisma.providerApiKey.findMany).mockImplementation((async (args: {
    where: { userId: string | null };
  }) => (args.where.userId === null ? global : own)) as never);
}

describe("readEndpointRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads every endpoint of the scope, leaving other providers out", async () => {
    serve(
      [row("custom-llamacpp"), row("anthropic"), row("custom-openrouter")],
      [row("custom-admin")],
    );

    const providers = (await readEndpointRows({ kind: "user", userId: "user-1" })).map(
      (endpoint) => endpoint.provider,
    );

    // The admin's endpoint comes along: its models are pickable for everyone.
    expect(providers).toEqual(["custom-llamacpp", "custom-openrouter", "custom-admin"]);
  });

  it("keeps the endpoint stored before endpoints had their own id", async () => {
    serve([row("custom")], []);

    const providers = (await readEndpointRows({ kind: "user", userId: "user-1" })).map(
      (endpoint) => endpoint.provider,
    );

    expect(providers).toEqual(["custom"]);
  });

  it("prefers the caller's own row over the admin's for the same endpoint", async () => {
    serve(
      [row("custom-llamacpp", { baseUrl: "http://mine.test/v1" })],
      [row("custom-llamacpp", { baseUrl: "http://admin.test/v1" })],
    );

    const rows = await readEndpointRows({ kind: "user", userId: "user-1" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.baseUrl).toBe("http://mine.test/v1");
  });

  it("reads only the global rows for the global scope", async () => {
    serve([row("custom-mine")], [row("custom-admin")]);

    const providers = (await readEndpointRows({ kind: "global" })).map((row) => row.provider);

    expect(providers).toEqual(["custom-admin"]);
  });
});

describe("readEndpointRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds one endpoint by its provider id", async () => {
    serve([row("custom-llamacpp"), row("custom-openrouter")], []);

    const endpoint = await readEndpointRow({ kind: "user", userId: "user-1" }, "custom-openrouter");

    expect(endpoint?.provider).toBe("custom-openrouter");
  });

  it("reports an endpoint the scope does not have", async () => {
    serve([row("custom-llamacpp")], []);

    expect(await readEndpointRow({ kind: "user", userId: "user-1" }, "custom-vllm")).toBeNull();
  });
});
