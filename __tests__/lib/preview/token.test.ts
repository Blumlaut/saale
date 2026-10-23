import { describe, expect, it } from "vitest";
import { PREVIEW_TOKEN_LENGTH, previewToken, verifyPreviewToken } from "@/lib/preview/token";

const KEY = "0123456789abcdef0123456789abcdef";

describe("preview tokens", () => {
  it("is stable, so a URL survives a reload", () => {
    const scope = { identity: "user-abc", port: 5173 };
    expect(previewToken(scope, KEY)).toBe(previewToken(scope, KEY));
    expect(previewToken(scope, KEY)).toHaveLength(PREVIEW_TOKEN_LENGTH);
    expect(previewToken(scope, KEY)).toMatch(/^[0-9a-f]+$/);
  });

  it("differs per port, per workspace and per key", () => {
    const base = { identity: "user-abc", port: 5173 };
    const token = previewToken(base, KEY);

    expect(previewToken({ ...base, port: 5174 }, KEY)).not.toBe(token);
    expect(previewToken({ ...base, identity: "user-def" }, KEY)).not.toBe(token);
    expect(previewToken(base, "another-key")).not.toBe(token);
  });

  it("verifies a token it issued and nothing else", () => {
    const scope = { identity: "user-abc", port: 5173 };
    const token = previewToken(scope, KEY);

    expect(verifyPreviewToken(token, scope, KEY)).toBe(true);
    expect(verifyPreviewToken(token, { ...scope, port: 5174 }, KEY)).toBe(false);
    expect(verifyPreviewToken(token, { ...scope, identity: "user-def" }, KEY)).toBe(false);
    expect(verifyPreviewToken(token, scope, "another-key")).toBe(false);
  });

  it("refuses a tampered or malformed token", () => {
    const scope = { identity: "user-abc", port: 5173 };
    const token = previewToken(scope, KEY);
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    expect(verifyPreviewToken(tampered, scope, KEY)).toBe(false);
    expect(verifyPreviewToken("", scope, KEY)).toBe(false);
    expect(verifyPreviewToken("zzzz", scope, KEY)).toBe(false);
    expect(verifyPreviewToken(token.toUpperCase(), scope, KEY)).toBe(false);
  });

  it("refuses to sign without a key or with a port that is not one", () => {
    expect(() => previewToken({ identity: "user-abc", port: 5173 }, "")).toThrow();
    expect(() => previewToken({ identity: "user-abc", port: 0 }, KEY)).toThrow();
    expect(() => previewToken({ identity: "user-abc", port: 70000 }, KEY)).toThrow();
    expect(
      verifyPreviewToken("a".repeat(PREVIEW_TOKEN_LENGTH), { identity: "user-a", port: 80 }, ""),
    ).toBe(false);
  });
});
