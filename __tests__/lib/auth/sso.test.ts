/**
 * Single sign-on: what the deployment's environment turns into, and what the
 * login page and the sign-up gate read from it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSsoRedirectUri,
  discoveryUrlFor,
  getSsoOidcConfig,
  getSsoStatus,
  isSsoEmailAllowed,
  ssoOidcPlugins,
} from "@/lib/auth/sso";
import { SSO_SIGNUP_REFUSED, ssoLoginError } from "@/lib/auth/sso-login";

const SSO_ENV = [
  "SSO_OIDC_ISSUER",
  "SSO_OIDC_CLIENT_ID",
  "SSO_OIDC_CLIENT_SECRET",
  "SSO_OIDC_NAME",
  "SSO_OIDC_SCOPES",
  "SSO_ALLOWED_DOMAINS",
] as const;

function clearSsoEnv() {
  for (const key of SSO_ENV) delete process.env[key];
}

function configureSso(overrides: Partial<Record<(typeof SSO_ENV)[number], string>> = {}) {
  process.env.SSO_OIDC_ISSUER = "https://login.example.com/tenant";
  process.env.SSO_OIDC_CLIENT_ID = "saale";
  process.env.SSO_OIDC_CLIENT_SECRET = "secret";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(clearSsoEnv);
afterEach(clearSsoEnv);

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

describe("getSsoOidcConfig", () => {
  it("is null until the issuer and the client pair are all set", () => {
    expect(getSsoOidcConfig()).toBeNull();

    configureSso({ SSO_OIDC_CLIENT_SECRET: "" });
    expect(getSsoOidcConfig()).toBeNull();

    configureSso();
    expect(getSsoOidcConfig()).not.toBeNull();
  });

  it("defaults the label and the scopes", () => {
    configureSso();
    const config = getSsoOidcConfig();

    expect(config?.name).toBe("Single sign-on");
    expect(config?.scopes).toEqual(["openid", "profile", "email"]);
    expect(config?.allowedDomains).toEqual([]);
  });

  it("always asks for openid", () => {
    configureSso({ SSO_OIDC_SCOPES: "profile, email" });
    expect(getSsoOidcConfig()?.scopes).toEqual(["openid", "profile", "email"]);
  });

  it("reads a typed domain list into lowercase domains", () => {
    configureSso({ SSO_ALLOWED_DOMAINS: " Example.COM , @other.example " });
    expect(getSsoOidcConfig()?.allowedDomains).toEqual(["example.com", "other.example"]);
  });
});

describe("isSsoEmailAllowed", () => {
  it("matches the address's domain", () => {
    configureSso({ SSO_ALLOWED_DOMAINS: "example.com" });

    expect(isSsoEmailAllowed("ada@example.com")).toBe(true);
    expect(isSsoEmailAllowed("Ada@Example.COM")).toBe(true);
    expect(isSsoEmailAllowed("ada@sub.example.com")).toBe(false);
    expect(isSsoEmailAllowed("ada@example.com.evil.test")).toBe(false);
  });

  it("refuses everything when no domain is listed", () => {
    configureSso();
    expect(isSsoEmailAllowed("ada@example.com")).toBe(false);
  });

  it("refuses everything when the provider is not configured", () => {
    expect(isSsoEmailAllowed("ada@example.com")).toBe(false);
  });

  it("refuses an address with no domain", () => {
    configureSso({ SSO_ALLOWED_DOMAINS: "example.com" });
    expect(isSsoEmailAllowed("ada@")).toBe(false);
    expect(isSsoEmailAllowed("ada")).toBe(false);
  });
});

describe("ssoOidcPlugins", () => {
  it("registers nothing without credentials", () => {
    expect(ssoOidcPlugins()).toEqual([]);
  });

  it("registers the provider once it has credentials", () => {
    configureSso({ SSO_OIDC_NAME: "Company SSO" });
    const [plugin] = ssoOidcPlugins();
    const config = plugin?.options.config[0];

    expect(config?.providerId).toBe("sso-oidc");
    expect(config?.name).toBe("Company SSO");
    expect(config?.requireIdTokenVerification).toBe(true);
  });

  it("creates accounts only when a domain list opens the door", () => {
    configureSso();
    expect(ssoOidcPlugins()[0]?.options.config[0]?.disableImplicitSignUp).toBe(true);

    configureSso({ SSO_ALLOWED_DOMAINS: "example.com" });
    expect(ssoOidcPlugins()[0]?.options.config[0]?.disableImplicitSignUp).toBe(false);
  });
});

describe("getSsoStatus", () => {
  it("reports an unconfigured instance and the URI to register anyway", () => {
    const status = getSsoStatus();

    expect(status.enabled).toBe(false);
    expect(status.discoveryUrl).toBeNull();
    expect(status.redirectUri).toMatch(/\/api\/auth\/callback\/sso-oidc$/);
  });

  it("reports what the deployment set", () => {
    configureSso({ SSO_ALLOWED_DOMAINS: "example.com" });
    const status = getSsoStatus();

    expect(status.enabled).toBe(true);
    expect(status.discoveryUrl).toBe(
      "https://login.example.com/tenant/.well-known/openid-configuration",
    );
    expect(status.allowedDomains).toEqual(["example.com"]);
    expect(buildSsoRedirectUri()).toBe(status.redirectUri);
  });
});

describe("ssoLoginError", () => {
  it("names the provider in the shared sentences", () => {
    expect(ssoLoginError("account_not_linked", { provider: "Company SSO" })).toMatch(
      /Company SSO account is not linked/,
    );
  });

  it("explains a refused address", () => {
    expect(ssoLoginError("signup_disabled", { provider: "Company SSO" })).toBe(
      SSO_SIGNUP_REFUSED.message,
    );
    expect(ssoLoginError(SSO_SIGNUP_REFUSED.code, { provider: "Company SSO" })).toBe(
      SSO_SIGNUP_REFUSED.message,
    );
  });

  it("shows a code it does not know as it is", () => {
    expect(ssoLoginError("some_new_failure", { provider: "Company SSO" })).toBe("some_new_failure");
    expect(ssoLoginError(null, { provider: "Company SSO" })).toBeNull();
  });
});
