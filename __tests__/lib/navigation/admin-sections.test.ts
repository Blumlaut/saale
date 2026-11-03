import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_SECTIONS, adminSections, matchAdminSection } from "@/lib/navigation/admin-sections";

/**
 * Every section here is a page the admin sidebar and the phone picker link to.
 */

const ADMIN_APP_DIR = join(__dirname, "../../../src/app/admin");

const ENTRIES = Object.entries(ADMIN_SECTIONS);

describe("admin sections registry", () => {
  it("gives every section its own route page", () => {
    for (const [, sections] of ENTRIES) {
      for (const section of sections) {
        const route = section.href.replace(/^\/admin\//, "");
        expect(
          existsSync(join(ADMIN_APP_DIR, route, "page.tsx")),
          `admin section "${section.id}" has no page at ${section.href}`,
        ).toBe(true);
      }
    }
  });

  it("routes every section under the item that lists it", () => {
    for (const [itemHref, sections] of ENTRIES) {
      for (const section of sections) {
        expect(
          section.href.startsWith(`${itemHref}/`),
          `${section.href} is not under ${itemHref}`,
        ).toBe(true);
      }
    }
  });

  it("lists each section id once per item", () => {
    for (const [itemHref, sections] of ENTRIES) {
      const ids = sections.map((section) => section.id);
      expect(new Set(ids).size, `${itemHref} repeats a section id`).toBe(ids.length);
    }
  });

  it("reports no sections for a single-page area", () => {
    expect(adminSections("/admin/roles")).toEqual([]);
  });

  it("keeps the accounts list and the workspaces audit in the users area", () => {
    expect(adminSections("/admin/users").map((section) => section.href)).toEqual([
      "/admin/users/accounts",
      "/admin/users/workspaces",
      "/admin/users/usage",
    ]);
  });

  it("matches a section by its href, and nothing for a page outside them", () => {
    const sections = adminSections("/admin/users");
    expect(matchAdminSection(sections, "/admin/users/accounts")?.id).toBe("accounts");
    expect(matchAdminSection(sections, "/admin/users/workspaces")?.id).toBe("workspaces");
    expect(matchAdminSection(sections, "/admin/users/usage")?.id).toBe("usage");
    expect(matchAdminSection(sections, "/admin/roles")).toBeNull();
  });
});
