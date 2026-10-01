import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { describe, expect, it } from "vitest";

import { isTotpCode, parseTotpSecret } from "@/lib/auth/totp";

const SECRET = "JBSWY3DPEHPK3PXP";

describe("parseTotpSecret", () => {
  it("extracts the base32 secret from a generated otpauth URI", async () => {
    const uri = await createOTP(SECRET, { digits: 6, period: 30 }).url("Saale", "test@example.com");
    expect(uri).toContain("otpauth://");
    expect(parseTotpSecret(uri)).toMatch(/^[A-Z2-7]+$/);
  });

  it("normalizes lowercase and spaced secrets", () => {
    expect(parseTotpSecret("otpauth://totp/Saale?secret=jbsw y3dp ehpk3pxp")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
  });

  it("returns null for URIs without a usable secret", () => {
    expect(parseTotpSecret("otpauth://totp/Saale?issuer=Saale")).toBeNull();
    expect(parseTotpSecret("otpauth://totp/Saale?secret=!!not-base32")).toBeNull();
    expect(parseTotpSecret("https://example.com?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(parseTotpSecret("not a uri at all")).toBeNull();
    expect(parseTotpSecret("")).toBeNull();
  });
});

describe("isTotpCode", () => {
  it("accepts exactly six digits", () => {
    expect(isTotpCode("012345")).toBe(true);
    expect(isTotpCode("999999")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("1234567")).toBe(false);
    expect(isTotpCode("12345a")).toBe(false);
    expect(isTotpCode(" 12345")).toBe(false);
    expect(isTotpCode("")).toBe(false);
  });
});

describe("TOTP round trip (server algorithm)", () => {
  it("decodes the URI secret back to the original key and verifies a code", async () => {
    const uri = await createOTP(SECRET, { digits: 6, period: 30 }).url("Saale", "test@example.com");
    // The URI encodes the secret as base32; decoding it must yield the
    // original key so authenticator apps and the server stay in sync.
    const decoded = Buffer.from(base32.decode(parseTotpSecret(uri)!)).toString("latin1");
    expect(decoded).toBe(SECRET);
    const otp = createOTP(decoded, { digits: 6, period: 30 });
    const code = await otp.totp();
    await expect(otp.verify(code)).resolves.toBe(true);
  });

  it("rejects a wrong code", async () => {
    const otp = createOTP(SECRET, { digits: 6, period: 30 });
    const code = await otp.totp();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    await expect(otp.verify(wrong)).resolves.toBe(false);
  });
});
