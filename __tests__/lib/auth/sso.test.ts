/**
 * Single sign-on: what the panel's stored providers turn into, and what the
 * login page and the sign-up gate read from them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany, mockFindUnique, mockCreate, mockUpdate, mockDeleteMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    instanceSso: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));

import { _resetKey, decrypt, encrypt } from "@/lib/crypto";
import {
  buildSsoRedirectUri,
  createSsoProvider,
  discoveryUrlFor,
  getSsoLoginProviders,
  invalidateSsoConfig,
  isSsoCallbackPath,
  isSsoEmailAllowed,
  listSsoProviders,
  loadSsoConfig,
  normalizeDomains,
  normalizeIssuer,
  normalizeScopes,
  providerIdFromCallbackPath,
  removeSsoProvider,
  ssoOidcPlugins,
  ssoProviderCreateSchema,
  updateSsoProvider,
} from "@/lib/auth/sso";
import { SSO_SIGNUP_REFUSED, ssoLoginError } from "@/lib/auth/sso-login";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "sso-1",
    slug: "abc12345",
    enabled: true,
    issuer: "https://login.example.com/tenant",
    clientId: "saale",
    encryptedClientSecret: encrypt("secret"),
    name: "Company SSO",
    scopes: ["openid", "profile", "email"],
    allowedDomains: [],
    updatedByUserId: "admin-1",
    updatedAt: new Date("2026-11-12T10:00:00Z"),
    ...overrides,
  };
}

function createdRow(): Record<string, unknown> {
  const call = mockCreate.mock.calls.at(-1);
  if (!call) throw new Error("instanceSso.create was not called");
  return (call[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  _resetKey();
  invalidateSsoConfig();
  mockFindMany.mockReset();
  mockFindUnique.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDeleteMany.mockReset();
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  _resetKey();
});

describe("discoveryUrlFor", () => {
  it("appends the well-known path to an issuer", () => {
    expect(discoveryUrlFor("https://login.example.com/tenant")).toBe(
      "https://login.example.com/tenant/.well-known/openid-configuration",
    );
  });

  it("keeps a discovery document as it is", () => {
    const url = "https://login.example.com/.well-known/openid-configuration";
    expect(discoveryUrlFor(url)).toBe(url);
  });

  it("ignores a trailing slash", () => {
    expect(discoveryUrlFor("https://login.example.com/")).toBe(
      "https://login.example.com/.well-known/openid-configuration",
    );
  });
});

describe("normalizeIssuer", () => {
  it("gives a pasted host its scheme", () => {
    expect(normalizeIssuer(" login.example.com/tenant ")).toBe("https://login.example.com/tenant");
  });

  it("leaves an address that carries one alone", () => {
    expect(normalizeIssuer("http://localhost:8080/realms/saale")).toBe(
      "http://localhost:8080/realms/saale",
    );
  });

  it("keeps an empty issuer empty", () => {
    expect(normalizeIssuer("   ")).toBe("");
  });
});

describe("normalizeDomains", () => {
  it("lowercases, drops the at sign and repeats", () => {
    expect(normalizeDomains([" Example.COM ", "@other.example", "example.com", ""])).toEqual([
      "example.com",
      "other.example",
    ]);
  });
});

describe("normalizeScopes", () => {
  it("defaults the scopes", () => {
    expect(normalizeScopes([])).toEqual(["openid", "profile", "email"]);
  });

  it("always asks for openid", () => {
    expect(normalizeScopes(["profile", "email"])).toEqual(["openid", "profile", "email"]);
  });
});

describe("callback paths", () => {
  it("recognises a provider callback and reads its id", () => {
    expect(isSsoCallbackPath("/callback/sso-abc12345")).toBe(true);
    expect(providerIdFromCallbackPath("/callback/sso-abc12345")).toBe("sso-abc12345");
  });

  it("leaves every other path alone", () => {
    expect(isSsoCallbackPath("/callback/telegram-oidc")).toBe(false);
    expect(isSsoCallbackPath("/sign-in/social")).toBe(false);
    expect(isSsoCallbackPath(undefined)).toBe(false);
    expect(providerIdFromCallbackPath("/callback/telegram-oidc")).toBeNull();
  });
});

describe("loadSsoConfig", () => {
  it("is empty until a provider is stored", async () => {
    mockFindMany.mockResolvedValue([]);
    expect((await loadSsoConfig()).providers).toEqual([]);
  });

  it("drops a provider that is switched off, unfinished, or will not decrypt", async () => {
    mockFindMany.mockResolvedValue([
      row({ id: "sso-1", slug: "one" }),
      row({ id: "sso-2", slug: "two", enabled: false }),
      row({ id: "sso-3", slug: "three", clientId: "" }),
      row({ id: "sso-4", slug: "four", encryptedClientSecret: null }),
      row({ id: "sso-5", slug: "five", encryptedClientSecret: "not-a-ciphertext" }),
    ]);

    const { providers } = await loadSsoConfig();

    expect(providers.map((provider) => provider.providerId)).toEqual(["sso-one"]);
  });

  it("reads a stored row into the provider", async () => {
    mockFindMany.mockResolvedValue([
      row({ allowedDomains: ["Example.com"], scopes: ["profile"], name: "Contoso" }),
    ]);

    const [config] = (await loadSsoConfig()).providers;

    expect(config?.providerId).toBe("sso-abc12345");
    expect(config?.discoveryUrl).toBe(
      "https://login.example.com/tenant/.well-known/openid-configuration",
    );
    expect(config?.clientId).toBe("saale");
    expect(config?.clientSecret).toBe("secret");
    expect(config?.name).toBe("Contoso");
    expect(config?.scopes).toEqual(["openid", "profile"]);
    expect(config?.allowedDomains).toEqual(["example.com"]);
  });

  it("labels an unnamed provider", async () => {
    mockFindMany.mockResolvedValue([row({ name: "" })]);
    expect((await loadSsoConfig()).providers[0]?.name).toBe("Single sign-on");
  });

  it("keeps the same version while the stored list is unchanged", async () => {
    mockFindMany.mockResolvedValue([row()]);
    const first = await loadSsoConfig();

    mockFindMany.mockResolvedValue([row()]);
    expect((await loadSsoConfig()).version).toBe(first.version);

    mockFindMany.mockResolvedValue([row({ clientId: "other" })]);
    expect((await loadSsoConfig()).version).toBeGreaterThan(first.version);
  });

  it("keeps sign-in up when the list cannot be read", async () => {
    mockFindMany.mockRejectedValue(new Error("connection refused"));
    expect((await loadSsoConfig()).providers).toEqual([]);
  });
});

describe("isSsoEmailAllowed", () => {
  it("matches the address's domain on the provider that asked", async () => {
    mockFindMany.mockResolvedValue([
      row({ slug: "one", allowedDomains: ["example.com"] }),
      row({ slug: "two", allowedDomains: ["other.example"] }),
    ]);

    expect(await isSsoEmailAllowed("ada@example.com", "sso-one")).toBe(true);
    expect(await isSsoEmailAllowed("Ada@Example.COM", "sso-one")).toBe(true);
    expect(await isSsoEmailAllowed("ada@sub.example.com", "sso-one")).toBe(false);
    expect(await isSsoEmailAllowed("ada@example.com.evil.test", "sso-one")).toBe(false);
  });

  it("does not carry one provider's list over to another", async () => {
    mockFindMany.mockResolvedValue([
      row({ slug: "one", allowedDomains: ["example.com"] }),
      row({ slug: "two", allowedDomains: [] }),
    ]);

    expect(await isSsoEmailAllowed("ada@example.com", "sso-two")).toBe(false);
  });

  it("refuses everything for a provider that is not registered", async () => {
    mockFindMany.mockResolvedValue([row({ slug: "one", allowedDomains: ["example.com"] })]);
    expect(await isSsoEmailAllowed("ada@example.com", "sso-gone")).toBe(false);
  });

  it("refuses an address with no domain", async () => {
    mockFindMany.mockResolvedValue([row({ slug: "one", allowedDomains: ["example.com"] })]);
    expect(await isSsoEmailAllowed("ada@", "sso-one")).toBe(false);
    expect(await isSsoEmailAllowed("ada", "sso-one")).toBe(false);
  });
});

describe("ssoOidcPlugins", () => {
  it("registers nothing without a provider", () => {
    expect(ssoOidcPlugins([])).toEqual([]);
  });

  it("registers one entry per provider", () => {
    const [plugin] = ssoOidcPlugins([
      {
        providerId: "sso-one",
        discoveryUrl: "https://one.example.com/.well-known/openid-configuration",
        clientId: "saale",
        clientSecret: "secret",
        name: "One",
        scopes: ["openid"],
        allowedDomains: [],
      },
      {
        providerId: "sso-two",
        discoveryUrl: "https://two.example.com/.well-known/openid-configuration",
        clientId: "saale-two",
        clientSecret: "secret-two",
        name: "Two",
        scopes: ["openid"],
        allowedDomains: ["example.com"],
      },
    ]);

    const config = plugin?.options.config ?? [];

    expect(config.map((entry) => entry.providerId)).toEqual(["sso-one", "sso-two"]);
    expect(config[0]?.requireIdTokenVerification).toBe(true);
    expect(config[0]?.disableImplicitSignUp).toBe(true);
    expect(config[1]?.disableImplicitSignUp).toBe(false);
  });
});

describe("listSsoProviders", () => {
  it("reports an unfinished provider and the URI to register anyway", async () => {
    mockFindMany.mockResolvedValue([
      row({ issuer: "", clientId: "", encryptedClientSecret: null }),
    ]);
    const [provider] = await listSsoProviders();

    expect(provider?.configured).toBe(false);
    expect(provider?.hasClientSecret).toBe(false);
    expect(provider?.discoveryUrl).toBeNull();
    expect(provider?.redirectUri).toBe(buildSsoRedirectUri("sso-abc12345"));
    expect(provider?.redirectUri).toMatch(/\/api\/auth\/callback\/sso-abc12345$/);
  });

  it("reports what the panel stored, without the secret", async () => {
    mockFindMany.mockResolvedValue([row({ allowedDomains: ["Example.com"] })]);
    const [provider] = await listSsoProviders();

    expect(provider?.configured).toBe(true);
    expect(provider?.hasClientSecret).toBe(true);
    expect(provider?.allowedDomains).toEqual(["example.com"]);
    expect(provider).not.toHaveProperty("clientSecret");
    expect(provider).not.toHaveProperty("encryptedClientSecret");
  });

  it("lists every provider, ready or not", async () => {
    mockFindMany.mockResolvedValue([
      row({ id: "sso-1", slug: "one" }),
      row({ id: "sso-2", slug: "two", enabled: false }),
    ]);
    expect((await listSsoProviders()).map((provider) => provider.providerId)).toEqual([
      "sso-one",
      "sso-two",
    ]);
  });
});

describe("getSsoLoginProviders", () => {
  it("offers a button only for a provider that is ready", async () => {
    mockFindMany.mockResolvedValue([
      row({ slug: "one", name: "Contoso" }),
      row({ slug: "two", name: "Fabrikam", clientId: "" }),
      row({ slug: "three", name: "Off", enabled: false }),
    ]);

    expect(await getSsoLoginProviders()).toEqual([{ id: "sso-one", name: "Contoso" }]);
  });
});

describe("createSsoProvider", () => {
  it("gives the provider a slug, encrypts the secret and normalizes the rest", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data, updatedAt: new Date("2026-11-12T10:00:00Z") }),
    );

    const provider = await createSsoProvider(
      {
        name: " Company SSO ",
        issuer: "login.example.com/tenant",
        clientId: " saale ",
        allowedDomains: ["Example.com", "@other.example"],
        scopes: ["profile"],
        clientSecret: "shhh",
      },
      "admin-1",
    );

    const data = createdRow();
    expect(String(data.slug)).toMatch(/^[0-9a-f]{12}$/);
    expect(data.name).toBe("Company SSO");
    expect(data.issuer).toBe("https://login.example.com/tenant");
    expect(data.clientId).toBe("saale");
    expect(data.allowedDomains).toEqual(["example.com", "other.example"]);
    expect(data.scopes).toEqual(["openid", "profile"]);
    expect(data.updatedByUserId).toBe("admin-1");
    expect(data.encryptedClientSecret).not.toBe("shhh");
    expect(decrypt(data.encryptedClientSecret as string)).toBe("shhh");
    expect(provider.providerId).toBe(`sso-${String(data.slug)}`);
  });

  it("adds a provider with nothing filled in yet", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data, updatedAt: new Date("2026-11-12T10:00:00Z") }),
    );

    const provider = await createSsoProvider({ name: "Later" }, "admin-1");

    expect(provider.configured).toBe(false);
    expect(createdRow().encryptedClientSecret).toBeNull();
  });

  it("refuses an issuer that is not an address", async () => {
    await expect(
      createSsoProvider({ name: "Bad", issuer: "ftp://login.example.com" }, "admin-1"),
    ).rejects.toThrow(/http or https/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("needs a name", () => {
    expect(ssoProviderCreateSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("updateSsoProvider", () => {
  it("keeps a stored secret when the form leaves it empty", async () => {
    const stored = encrypt("stored");
    mockFindUnique.mockResolvedValue(row({ encryptedClientSecret: stored }));
    mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data }),
    );

    await updateSsoProvider("sso-1", { name: "Renamed" }, "admin-1");

    const data = (mockUpdate.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
    expect(data.encryptedClientSecret).toBe(stored);
    expect(data.name).toBe("Renamed");
  });

  it("forgets a secret cleared with null", async () => {
    mockFindUnique.mockResolvedValue(row());
    mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data }),
    );

    await updateSsoProvider("sso-1", { clientSecret: null }, "admin-1");

    const data = (mockUpdate.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
    expect(data.encryptedClientSecret).toBeNull();
  });

  it("answers null for a provider that is gone", async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await updateSsoProvider("sso-gone", { name: "Ghost" }, "admin-1")).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses an issuer that is not an address", async () => {
    mockFindUnique.mockResolvedValue(row());

    await expect(
      updateSsoProvider("sso-1", { issuer: "ftp://login.example.com" }, "admin-1"),
    ).rejects.toThrow(/http or https/);
  });

  it("forgets the cached list, so the next sign-in sees the save", async () => {
    mockFindMany.mockResolvedValue([row({ clientId: "old" })]);
    await loadSsoConfig();

    mockFindUnique.mockResolvedValue(row({ clientId: "old" }));
    mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data }),
    );
    await updateSsoProvider("sso-1", { clientId: "new" }, "admin-1");

    mockFindMany.mockResolvedValue([row({ clientId: "new" })]);
    const { providers } = await loadSsoConfig();
    expect(providers[0]?.clientId).toBe("new");
  });
});

describe("removeSsoProvider", () => {
  it("deletes the row and drops the cached list", async () => {
    mockFindMany.mockResolvedValue([row()]);
    await loadSsoConfig();

    mockDeleteMany.mockResolvedValue({ count: 1 });
    await removeSsoProvider("sso-1");

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "sso-1" } });

    mockFindMany.mockResolvedValue([]);
    expect((await loadSsoConfig()).providers).toEqual([]);
  });
});

describe("ssoLoginError", () => {
  it("names the provider in the shared sentences", () => {
    expect(ssoLoginError("account_not_linked", { provider: "Company SSO" })).toMatch(
      /Company SSO account is not linked/,
    );
  });

  it("shows the refusal for a domain that is not allowed", () => {
    expect(ssoLoginError("signup_disabled", { provider: "Company SSO" })).toBe(
      SSO_SIGNUP_REFUSED.message,
    );
  });
});
