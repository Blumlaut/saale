import { describe, it, expect } from "vitest";
import { loginPath, queryOf, safeNextPath } from "@/lib/auth/redirect";

/**
 * `?next=` decides where a visitor lands after signing in, so a value that is
 * not a path of ours is an open redirect.
 */

describe("safeNextPath", () => {
  it("keeps a path with its query", () => {
    expect(safeNextPath("/dashboard/chat?q=explain%20this")).toBe(
      "/dashboard/chat?q=explain%20this",
    );
  });

  it("rejects anything that leaves this site", () => {
    const hostile = [
      "https://evil.example",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "dashboard/chat",
      "",
      null,
      undefined,
    ];

    for (const next of hostile) {
      expect(safeNextPath(next)).toBeNull();
    }
  });

  it("keeps the query when a page redirects a visitor on", () => {
    expect(queryOf("/?q=explain%20this")).toBe("?q=explain%20this");
    expect(queryOf("/dashboard/chat")).toBe("");
    expect(queryOf(null)).toBe("");
  });

  it("builds a login URL that carries the path", () => {
    expect(loginPath("/dashboard/chat?q=a%20b")).toBe(
      "/auth/login?next=%2Fdashboard%2Fchat%3Fq%3Da%2520b",
    );
  });
});
