/**
 * Single sign-on: what the panel's stored row turns into, and what the login
 * page and the sign-up gate read from it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockUpsert, mockDeleteMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    instanceSso: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));

import { _resetKey, decrypt, encrypt } from "@/lib/crypto";
import {
  buildSsoRedirectUri,
  clearInstanceSso,
  discoveryUrlFor,
  getSsoStatus,
  invalidateSsoConfig,
  isSsoEmailAllowed,
  loadSsoConfig,
  normalizeDomains,
  normalizeIssuer,
  normalizeScopes,
  saveInstanceSso,
  ssoOidcPlugins,
} from "@/lib/auth/sso";
import { SSO_SIGNUP_REFUSED, ssoLoginError } from "@/lib/auth/sso-login";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    enabled: true,
    issuer: "https://login.example.com/tenant",
    clientId: "saale",
    encryptedClientSecret: encrypt("secret"),
    name: "",
    scopes: ["openid", "profile", "email"],
    allowedDomains: [],
    updatedByUserId: "admin-1",
    updatedAt: new Date("2026-11-12T10:00:00Z"),
    ...overrides,
  };
}

/** The row the last save asked Prisma to write. */
function savedRow(): { create: Record<string, unknown>; update: Record<string, unknown> } {
  const call = mockUpsert.mock.calls.at(-1);
  if (!call) throw new Error("instanceSso.upsert was not called");
  return call[0] as { create: Record<string, unknown>; update: Record<string, unknown> };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  _resetKey();
  invalidateSsoConfig();
  mockFindUnique.mockReset();
  mockUpsert.mockReset();
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

describe("loadSsoConfig", () => {
  it("is null until a provider is stored", async () => {
    mockFindUnique.mockResolvedValue(null);
    expect((await loadSsoConfig()).config).toBeNull();
  });

  it("is null while the switch is off", async () => {
    mockFindUnique.mockResolvedValue(row({ enabled: false }));
    expect((await loadSsoConfig()).config).toBeNull();
  });

  it("is null without a client secret", async () => {
    mockFindUnique.mockResolvedValue(row({ encryptedClientSecret: null }));
    expect((await loadSsoConfig()).config).toBeNull();
  });

  it("is null when the secret will not decrypt", async () => {
    mockFindUnique.mockResolvedValue(row({ encryptedClientSecret: "not-a-ciphertext" }));
    expect((await loadSsoConfig()).config).toBeNull();
  });

  it("reads the stored row into the provider", async () => {
    mockFindUnique.mockResolvedValue(
      row({ allowedDomains: ["Example.com"], name: "Company SSO", scopes: ["profile"] }),
    );

    const { config } = await loadSsoConfig();

    expect(config?.discoveryUrl).toBe(
      "https://login.example.com/tenant/.well-known/openid-configuration",
    );
    expect(config?.clientId).toBe("saale");
    expect(config?.clientSecret).toBe("secret");
    expect(config?.name).toBe("Company SSO");
    expect(config?.scopes).toEqual(["openid", "profile"]);
    expect(config?.allowedDomains).toEqual(["example.com"]);
  });

  it("labels an unnamed provider", async () => {
    mockFindUnique.mockResolvedValue(row());
    expect((await loadSsoConfig()).config?.name).toBe("Single sign-on");
  });

  it("keeps the same version while the stored row is unchanged", async () => {
    mockFindUnique.mockResolvedValue(row());
    const first = await loadSsoConfig();

    const unchanged = await loadSsoConfig();
    expect(unchanged.version).toBe(first.version);

    mockFindUnique.mockResolvedValue(row({ clientId: "other" }));
    const changed = await loadSsoConfig();
    expect(changed.version).toBeGreaterThan(first.version);
  });

  it("bumps the version when the cache is dropped, so auth is rebuilt", async () => {
    mockFindUnique.mockResolvedValue(row());
    const first = await loadSsoConfig();

    invalidateSsoConfig();

    expect((await loadSsoConfig()).version).toBeGreaterThan(first.version);
  });

  it("keeps sign-in up when the row cannot be read", async () => {
    mockFindUnique.mockRejectedValue(new Error("connection refused"));
    expect((await loadSsoConfig()).config).toBeNull();
  });
});

describe("isSsoEmailAllowed", () => {
  it("matches the address's domain", async () => {
    mockFindUnique.mockResolvedValue(row({ allowedDomains: ["example.com"] }));

    expect(await isSsoEmailAllowed("ada@example.com")).toBe(true);
    expect(await isSsoEmailAllowed("Ada@Example.COM")).toBe(true);
    expect(await isSsoEmailAllowed("ada@sub.example.com")).toBe(false);
    expect(await isSsoEmailAllowed("ada@example.com.evil.test")).toBe(false);
  });

  it("refuses everything when no domain is listed", async () => {
    mockFindUnique.mockResolvedValue(row());
    expect(await isSsoEmailAllowed("ada@example.com")).toBe(false);
  });

  it("refuses everything when the provider is not configured", async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await isSsoEmailAllowed("ada@example.com")).toBe(false);
  });

  it("refuses an address with no domain", async () => {
    mockFindUnique.mockResolvedValue(row({ allowedDomains: ["example.com"] }));
    expect(await isSsoEmailAllowed("ada@")).toBe(false);
    expect(await isSsoEmailAllowed("ada")).toBe(false);
  });
});

describe("ssoOidcPlugins", () => {
  it("registers nothing without a provider", () => {
    expect(ssoOidcPlugins(null)).toEqual([]);
  });

  it("registers the provider it is given", () => {
    const [plugin] = ssoOidcPlugins({
      discoveryUrl: "https://login.example.com/.well-known/openid-configuration",
      clientId: "saale",
      clientSecret: "secret",
      name: "Company SSO",
      scopes: ["openid", "profile", "email"],
      allowedDomains: [],
    });
    const config = plugin?.options.config[0];

    expect(config?.providerId).toBe("sso-oidc");
    expect(config?.name).toBe("Company SSO");
    expect(config?.clientId).toBe("saale");
    expect(config?.requireIdTokenVerification).toBe(true);
  });

  it("creates accounts only when a domain list opens the door", () => {
    const base = {
      discoveryUrl: "https://login.example.com/.well-known/openid-configuration",
      clientId: "saale",
      clientSecret: "secret",
      name: "Single sign-on",
      scopes: ["openid"],
    };

    expect(
      ssoOidcPlugins({ ...base, allowedDomains: [] })[0]?.options.config[0]?.disableImplicitSignUp,
    ).toBe(true);
    expect(
      ssoOidcPlugins({ ...base, allowedDomains: ["example.com"] })[0]?.options.config[0]
        ?.disableImplicitSignUp,
    ).toBe(false);
  });
});

describe("getSsoStatus", () => {
  it("reports an unconfigured instance and the URI to register anyway", async () => {
    mockFindUnique.mockResolvedValue(null);
    const status = await getSsoStatus();

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.hasClientSecret).toBe(false);
    expect(status.discoveryUrl).toBeNull();
    expect(status.scopes).toEqual(["openid", "profile", "email"]);
    expect(status.redirectUri).toBe(buildSsoRedirectUri());
    expect(status.redirectUri).toMatch(/\/api\/auth\/callback\/sso-oidc$/);
  });

  it("reports what the panel stored, without the secret", async () => {
    mockFindUnique.mockResolvedValue(
      row({ allowedDomains: ["Example.com"], issuer: "https://login.example.com/tenant/" }),
    );
    const status = await getSsoStatus();

    expect(status.configured).toBe(true);
    expect(status.hasClientSecret).toBe(true);
    expect(status.issuer).toBe("https://login.example.com/tenant/");
    expect(status.discoveryUrl).toBe(
      "https://login.example.com/tenant/.well-known/openid-configuration",
    );
    expect(status.allowedDomains).toEqual(["example.com"]);
    expect(status).not.toHaveProperty("clientSecret");
  });

  it("is not configured while the switch is off", async () => {
    mockFindUnique.mockResolvedValue(row({ enabled: false }));
    expect((await getSsoStatus()).configured).toBe(false);
  });
});

describe("saveInstanceSso", () => {
  it("normalizes what was typed and encrypts the secret", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({});

    await saveInstanceSso(
      {
        issuer: "login.example.com/tenant",
        clientId: " saale ",
        allowedDomains: ["Example.com", "@other.example"],
        scopes: ["profile"],
        clientSecret: "shhh",
      },
      "admin-1",
    );

    const { create } = savedRow();
    expect(create.issuer).toBe("https://login.example.com/tenant");
    expect(create.clientId).toBe("saale");
    expect(create.allowedDomains).toEqual(["example.com", "other.example"]);
    expect(create.scopes).toEqual(["openid", "profile"]);
    expect(create.updatedByUserId).toBe("admin-1");
    expect(create.encryptedClientSecret).not.toBe("shhh");
    expect(decrypt(create.encryptedClientSecret as string)).toBe("shhh");
  });

  it("keeps a stored secret when the form leaves it empty", async () => {
    const stored = encrypt("stored");
    mockFindUnique.mockResolvedValue(row({ encryptedClientSecret: stored }));
    mockUpsert.mockResolvedValue({});

    await saveInstanceSso({ name: "Company SSO" }, "admin-1");

    expect(savedRow().update.encryptedClientSecret).toBe(stored);
    expect(savedRow().update.name).toBe("Company SSO");
  });

  it("forgets a secret cleared with null", async () => {
    mockFindUnique.mockResolvedValue(row());
    mockUpsert.mockResolvedValue({});

    await saveInstanceSso({ clientSecret: null }, "admin-1");

    expect(savedRow().update.encryptedClientSecret).toBeNull();
  });

  it("refuses an issuer that is not an address", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(saveInstanceSso({ issuer: "ftp://login.example.com" }, "admin-1")).rejects.toThrow(
      /http or https/,
    );
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("forgets the cached provider, so the next sign-in sees the save", async () => {
    mockFindUnique.mockResolvedValue(row());
    await loadSsoConfig();

    mockFindUnique.mockResolvedValue(row({ clientId: "changed" }));
    mockUpsert.mockResolvedValue({});
    await saveInstanceSso({ clientId: "changed" }, "admin-1");

    const { config } = await loadSsoConfig();
    expect(config?.clientId).toBe("changed");
  });
});

describe("clearInstanceSso", () => {
  it("deletes the row and drops the cached provider", async () => {
    mockFindUnique.mockResolvedValue(row());
    await loadSsoConfig();

    mockDeleteMany.mockResolvedValue({ count: 1 });
    await clearInstanceSso();

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "global" } });

    mockFindUnique.mockResolvedValue(null);
    expect((await loadSsoConfig()).config).toBeNull();
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
