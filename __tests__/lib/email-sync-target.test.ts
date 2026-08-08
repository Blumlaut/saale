import { describe, it, expect } from "vitest";
import { emailSyncEndpoint } from "@/lib/email/sync-target";

describe("emailSyncEndpoint", () => {
  it("targets all accounts when no account is selected", () => {
    expect(emailSyncEndpoint(null)).toBe("/api/email/sync");
    expect(emailSyncEndpoint(undefined)).toBe("/api/email/sync");
  });

  it("targets the selected account when one is active", () => {
    expect(emailSyncEndpoint("acc-123")).toBe("/api/email/accounts/acc-123/sync");
  });

  it("treats an empty account id like no selection", () => {
    expect(emailSyncEndpoint("")).toBe("/api/email/sync");
  });

  it("builds the per-account URL from arbitrary ids", () => {
    expect(emailSyncEndpoint("acc-a")).toBe("/api/email/accounts/acc-a/sync");
    expect(emailSyncEndpoint("acc-xyz-42")).toBe("/api/email/accounts/acc-xyz-42/sync");
  });
});
