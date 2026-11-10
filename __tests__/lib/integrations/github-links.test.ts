import { describe, expect, it } from "vitest";

import {
  appInstallUrl,
  installationSettingsUrl,
  manageInstallationsUrl,
} from "@/lib/integrations/github-links";

const person = {
  installationId: "180537571",
  accountLogin: "Juli04",
  accountType: "User",
  suspended: false,
};

const org = {
  installationId: "42",
  accountLogin: "acme-tools",
  accountType: "Organization",
  suspended: false,
};

describe("github links", () => {
  it("points a personal installation at the user's settings", () => {
    expect(installationSettingsUrl(person)).toBe(
      "https://github.com/settings/installations/180537571",
    );
  });

  it("points an organization installation at the organization's settings", () => {
    expect(installationSettingsUrl(org)).toBe(
      "https://github.com/organizations/acme-tools/settings/installations/42",
    );
  });

  it("starts a new installation on the app's page", () => {
    expect(appInstallUrl("askguenther-test")).toBe(
      "https://github.com/apps/askguenther-test/installations/new",
    );
  });

  it("never emits the app path GitHub does not serve", () => {
    for (const url of [installationSettingsUrl(person), manageInstallationsUrl("app", [person])]) {
      expect(url).not.toMatch(/\/apps\/[^/]+\/installations\/?$/);
    }
  });

  it("sends an account without an installation to the install page", () => {
    expect(manageInstallationsUrl("askguenther-test", [])).toBe(
      "https://github.com/apps/askguenther-test/installations/new",
    );
  });

  it("configures the first usable installation, skipping a suspended one", () => {
    expect(manageInstallationsUrl("app", [{ ...person, suspended: true }, org])).toBe(
      "https://github.com/organizations/acme-tools/settings/installations/42",
    );
  });

  it("falls back to the suspended installation when nothing else is left", () => {
    expect(manageInstallationsUrl("app", [{ ...org, suspended: true }])).toBe(
      "https://github.com/organizations/acme-tools/settings/installations/42",
    );
  });

  it("escapes a login that would otherwise break the path", () => {
    expect(installationSettingsUrl({ ...org, accountLogin: "a b" })).toBe(
      "https://github.com/organizations/a%20b/settings/installations/42",
    );
  });
});
