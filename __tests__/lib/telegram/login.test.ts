import { describe, it, expect } from "vitest";
import { TELEGRAM_OIDC_PROVIDER_ID, telegramLoginError } from "@/lib/telegram/login";

describe("Telegram login copy", () => {
  it("names the provider better-auth's callback path is built from", () => {
    expect(TELEGRAM_OIDC_PROVIDER_ID).toBe("telegram-oidc");
  });

  it("turns the callback's error codes into sentences", () => {
    expect(telegramLoginError("account_not_linked")).toMatch(/not linked/);
    expect(telegramLoginError("invalid_code")).toMatch(/rejected/);
    // better-auth passes API error codes through untouched, in their own casing.
    expect(telegramLoginError("SIGNUPS_DISABLED")).toMatch(/Sign-ups are disabled/);
    expect(telegramLoginError("  State_Mismatch  ")).toMatch(/verified/);
  });

  it("shows an unrecognized code as it came, rather than hiding it", () => {
    expect(telegramLoginError("some_new_failure")).toBe("some_new_failure");
  });

  it("points an unlinked Telegram login at the register page when sign-ups are open", () => {
    expect(telegramLoginError("signup_disabled", { signupsEnabled: true })).toMatch(
      /Sign up with Telegram to create one/,
    );
  });

  it("says sign-ups are shut when there is nowhere to send an unlinked login", () => {
    expect(telegramLoginError("signup_disabled", { signupsEnabled: false })).toMatch(
      /sign-ups are not open/,
    );
  });

  it("has nothing to say when the redirect carries no error", () => {
    expect(telegramLoginError(null)).toBeNull();
    expect(telegramLoginError(undefined)).toBeNull();
    expect(telegramLoginError("")).toBeNull();
  });
});
