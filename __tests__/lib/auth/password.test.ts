import { describe, expect, it } from "vitest";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/auth/password";

describe("passwordProblem", () => {
  it.each([
    ["x".repeat(PASSWORD_MIN_LENGTH), null],
    ["x".repeat(PASSWORD_MIN_LENGTH + 1), null],
    ["x".repeat(PASSWORD_MAX_LENGTH), null],
    ["", `At least ${PASSWORD_MIN_LENGTH} characters`],
    ["x".repeat(PASSWORD_MIN_LENGTH - 1), `At least ${PASSWORD_MIN_LENGTH} characters`],
    ["x".repeat(PASSWORD_MAX_LENGTH + 1), `At most ${PASSWORD_MAX_LENGTH} characters`],
  ])("reports %j as %j", (password, expected) => {
    expect(passwordProblem(password)).toBe(expected);
  });

  it("counts characters, not bytes", () => {
    expect(passwordProblem("ä".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordProblem("🔒".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });
});
