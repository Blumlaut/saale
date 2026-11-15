import { afterEach, describe, expect, it } from "vitest";
import { restoreEnv } from "./env";

/**
 * Restoring an env var is the one place a test can silently change what every
 * later test reads, because `process.env.NAME = undefined` stores the string
 * "undefined".
 */

const NAME = "SAALE_TEST_RESTORE_ENV";
const original = process.env[NAME];

afterEach(() => {
  restoreEnv(NAME, original);
});

describe("restoreEnv", () => {
  it("puts a value back", () => {
    process.env[NAME] = "changed";
    restoreEnv(NAME, "kept");

    expect(process.env[NAME]).toBe("kept");
  });

  it("unsets a variable that was not set to begin with", () => {
    process.env[NAME] = "changed";
    restoreEnv(NAME, undefined);

    expect(process.env[NAME]).toBeUndefined();
  });
});
