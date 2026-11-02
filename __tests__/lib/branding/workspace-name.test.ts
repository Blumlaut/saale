import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_NAME,
  MAX_WORKSPACE_NAME_LENGTH,
  normalizeWorkspaceName,
} from "@/lib/branding/workspace-name";

describe("normalizeWorkspaceName", () => {
  it("uses the built-in name while the setting is empty", () => {
    expect(normalizeWorkspaceName("")).toBe(DEFAULT_WORKSPACE_NAME);
    expect(normalizeWorkspaceName("   ")).toBe(DEFAULT_WORKSPACE_NAME);
    expect(normalizeWorkspaceName(null)).toBe(DEFAULT_WORKSPACE_NAME);
    expect(normalizeWorkspaceName(undefined)).toBe(DEFAULT_WORKSPACE_NAME);
  });

  it("keeps the admin's name, trimmed", () => {
    expect(normalizeWorkspaceName("  Acme Console  ")).toBe("Acme Console");
  });

  it("cuts a name longer than the wordmark holds", () => {
    const long = `Acme ${"x".repeat(MAX_WORKSPACE_NAME_LENGTH)}`;

    expect(normalizeWorkspaceName(long)).toHaveLength(MAX_WORKSPACE_NAME_LENGTH);
  });
});
