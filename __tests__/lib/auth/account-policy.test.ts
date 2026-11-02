import { describe, expect, it } from "vitest";

import {
  accountPolicyProblem,
  clampMinPasswordLength,
  DEFAULT_ACCOUNT_POLICY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  passwordRules,
} from "@/lib/auth/password";

describe("clampMinPasswordLength", () => {
  it.each([
    [undefined, PASSWORD_MIN_LENGTH],
    [null, PASSWORD_MIN_LENGTH],
    [Number.NaN, PASSWORD_MIN_LENGTH],
    [4, PASSWORD_MIN_LENGTH],
    [12, 12],
    [12.6, 13],
    [PASSWORD_MAX_LENGTH + 20, PASSWORD_MAX_LENGTH],
  ])("holds %j at %i", (value, expected) => {
    expect(clampMinPasswordLength(value)).toBe(expected);
  });
});

describe("passwordProblem at a raised minimum", () => {
  it("accepts the minimum and refuses one character less", () => {
    expect(passwordProblem("x".repeat(12), 12)).toBeNull();
    expect(passwordProblem("x".repeat(11), 12)).toBe(passwordRules(12));
  });

  it("keeps the upper bound", () => {
    expect(passwordProblem("x".repeat(PASSWORD_MAX_LENGTH + 1), 12)).toBe(
      `At most ${PASSWORD_MAX_LENGTH} characters`,
    );
  });

  it("measures against the built-in minimum by default", () => {
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(passwordRules());
  });
});

describe("accountPolicyProblem", () => {
  const raised = { ...DEFAULT_ACCOUNT_POLICY, minPasswordLength: 14 };

  it("names the length in a sentence", () => {
    expect(accountPolicyProblem("x".repeat(13), raised)).toBe(
      "The password needs at least 14 characters.",
    );
  });

  it("passes a password the policy accepts", () => {
    expect(accountPolicyProblem("x".repeat(14), raised)).toBeNull();
    expect(accountPolicyProblem("x".repeat(8), DEFAULT_ACCOUNT_POLICY)).toBeNull();
  });
});
