import { describe, expect, it } from "vitest";

import { gitIdentityFor } from "@/lib/coder/gitconfig";

/**
 * Who a commit belongs to.
 *
 * An installation token pushes as the app, so without an explicit identity the
 * commit and the pull request read as the bot's work. GitHub links a commit to
 * the account whose `users.noreply.github.com` address it carries, which is why
 * the connected account wins as soon as there is one.
 */
describe("gitIdentityFor", () => {
  const user = { name: "Julian Test", username: "julian_test", email: "julian@example.com" };

  it("uses the account's own name and address without the app", () => {
    expect(gitIdentityFor(user)).toEqual({ name: "Julian Test", email: "julian@example.com" });
  });

  it("uses the GitHub account once the app pushes for it", () => {
    expect(gitIdentityFor(user, { login: "Juli04" })).toEqual({
      name: "Juli04",
      email: "Juli04@users.noreply.github.com",
    });
  });

  it("keeps the workspace's identity when no authorization is known", () => {
    expect(gitIdentityFor(user, null)).toEqual({
      name: "Julian Test",
      email: "julian@example.com",
    });
  });

  it("ignores a blank login rather than writing an empty address", () => {
    expect(gitIdentityFor(user, { login: "  " })).toEqual({
      name: "Julian Test",
      email: "julian@example.com",
    });
  });

  it("falls back to the username, then to a local address", () => {
    expect(gitIdentityFor({ name: null, username: "ada", email: "" })).toEqual({
      name: "ada",
      email: "saale@localhost",
    });
  });
});
