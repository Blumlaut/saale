import { describe, expect, it } from "vitest";
import {
  councilIdentity,
  deriveUserWorkspaceKey,
  InvalidSandboxIdentityError,
  isSandboxIdentity,
  parseIdentity,
  USER_WORKSPACE_KEY_LENGTH,
  userIdentity,
} from "@/lib/sandbox/identity";

describe("parseIdentity", () => {
  it("accepts the two shapes the app produces", () => {
    expect(parseIdentity("user-abc123")).toBe("user-abc123");
    expect(parseIdentity("council-abcd1234")).toBe("council-abcd1234");
  });

  it("refuses anything a caller might use to name another tree", () => {
    const rejected: unknown[] = [
      "user-",
      "user",
      "user-abc/../user-other",
      "user-../../etc",
      "council-abc/def",
      "user-abc\0",
      "/workspaces/user-abc",
      "user-abc\n",
      "admin-abc",
      "user-" + "a".repeat(65),
      null,
      undefined,
      42,
      { identity: "user-abc" },
    ];
    for (const raw of rejected) {
      expect(() => parseIdentity(raw)).toThrow(InvalidSandboxIdentityError);
      expect(isSandboxIdentity(raw)).toBe(false);
    }
  });

  it("refuses a path, whatever it contains", () => {
    expect(isSandboxIdentity("../user-abc")).toBe(false);
    expect(isSandboxIdentity("user-abc/")).toBe(false);
  });
});

describe("userIdentity", () => {
  const id = "yy7vfya8Gg33Y5ROHdK2WhZRKvGqs5NA";

  it("names the directory with a short key, not the id", () => {
    const identity = userIdentity(id);

    expect(identity).toBe(`user-${deriveUserWorkspaceKey(id)}`);
    expect(identity).toMatch(new RegExp(`^user-[0-9a-f]{${USER_WORKSPACE_KEY_LENGTH}}$`));
    expect(identity).not.toContain(id);
  });

  it("keeps the path an agent types far shorter than the id does", () => {
    expect(`/workspaces/${userIdentity(id)}`.length).toBeLessThan(`/workspaces/user-${id}`.length);
    expect(userIdentity(id).length).toBeLessThan(id.length);
  });

  it("is stable for one id and different for another", () => {
    expect(userIdentity(id)).toBe(userIdentity(id));
    expect(userIdentity("user-1")).not.toBe(userIdentity("user-2"));
  });

  it("does not collide across a large population of ids", () => {
    const identities = new Set<string>();
    for (let i = 0; i < 20000; i += 1) identities.add(userIdentity(`user-${i}`));

    expect(identities.size).toBe(20000);
  });

  it("refuses an id it cannot hash", () => {
    expect(() => userIdentity("")).toThrow(InvalidSandboxIdentityError);
    expect(() => deriveUserWorkspaceKey("")).toThrow(InvalidSandboxIdentityError);
  });
});

describe("councilIdentity", () => {
  it("prefixes the key so a user and a council can never collide", () => {
    expect(councilIdentity("abc123")).toBe("council-abc123");
    expect(councilIdentity("abc123")).not.toBe(userIdentity("abc123"));
  });

  it("refuses a key the pattern cannot carry", () => {
    expect(() => councilIdentity("../escape")).toThrow(InvalidSandboxIdentityError);
  });
});
