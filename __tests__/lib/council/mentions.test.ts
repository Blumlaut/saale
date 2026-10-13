import { describe, expect, it } from "vitest";
import {
  addressesEveryone,
  isValidMemberName,
  mentionHelp,
  parseMentions,
  resolveMentions,
} from "@/lib/council/mentions";

const MEMBERS = [
  { id: "m1", name: "acorn" },
  { id: "m2", name: "Blade" },
  { id: "m3", name: "cobalt-dust" },
];

describe("parseMentions", () => {
  it("reads handles in the order they appear, without duplicates", () => {
    expect(parseMentions("@blade and @acorn, then @blade again")).toEqual(["blade", "acorn"]);
  });

  it("lowercases handles, since resolution is case-insensitive", () => {
    expect(parseMentions("hey @Blade")).toEqual(["blade"]);
  });

  it("ignores an @ inside a word, which is how an email is written", () => {
    expect(parseMentions("write to ops@blade.example.com")).toEqual([]);
    expect(parseMentions("ping @blade@acorn")).toEqual(["blade"]);
  });

  it("handles punctuation around a handle", () => {
    expect(parseMentions("(@acorn): please check")).toEqual(["acorn"]);
    expect(parseMentions("`@acorn`")).toEqual(["acorn"]);
    expect(parseMentions("well then, @acorn- ok")).toEqual(["acorn"]);
    expect(parseMentions("@acorn's plan")).toEqual(["acorn"]);
  });

  it("takes the longest handle, so a hyphenated name is not split", () => {
    expect(parseMentions("@cobalt-dust please")).toEqual(["cobalt-dust"]);
  });

  it("finds nothing in text without handles", () => {
    expect(parseMentions("no addresses here")).toEqual([]);
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions("@")).toEqual([]);
    expect(parseMentions("@_")).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("resolves handles to member ids, case-insensitively", () => {
    const result = resolveMentions("@ACORN and @blade", MEMBERS);
    expect(result.memberIds).toEqual(["m1", "m2"]);
    expect(result.addressesUser).toBe(false);
    expect(result.unknown).toEqual([]);
  });

  it("reports the human and the room separately from members", () => {
    const result = resolveMentions("@user we need a decision, @all take note", MEMBERS);
    expect(result.addressesUser).toBe(true);
    expect(result.memberIds).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("reports handles that name nobody, instead of dropping them", () => {
    const result = resolveMentions("@acorn @ghost @phantom", MEMBERS);
    expect(result.memberIds).toEqual(["m1"]);
    expect(result.unknown).toEqual(["ghost", "phantom"]);
  });

  it("names each member once however often it is addressed", () => {
    expect(resolveMentions("@acorn @acorn @ACORN", MEMBERS).memberIds).toEqual(["m1"]);
  });
});

describe("isValidMemberName", () => {
  it("accepts single-token handles", () => {
    expect(isValidMemberName("acorn")).toBe(true);
    expect(isValidMemberName("cobalt-dust")).toBe(true);
    expect(isValidMemberName("r2_d2")).toBe(true);
  });

  it("refuses reserved handles, so @user cannot mean two things", () => {
    expect(isValidMemberName("user")).toBe(false);
    expect(isValidMemberName("all")).toBe(false);
    expect(isValidMemberName("system")).toBe(false);
    expect(isValidMemberName("USER")).toBe(false);
  });

  it("refuses names that are not one addressable token", () => {
    expect(isValidMemberName("two words")).toBe(false);
    expect(isValidMemberName("@acorn")).toBe(false);
    expect(isValidMemberName("-leading")).toBe(false);
    expect(isValidMemberName("")).toBe(false);
    expect(isValidMemberName("   ")).toBe(false);
    expect(isValidMemberName("a".repeat(51))).toBe(false);
  });
});

describe("addressesEveryone", () => {
  it("detects the broadcast handle only", () => {
    expect(addressesEveryone("@all status?")).toBe(true);
    expect(addressesEveryone("@acorn status?")).toBe(false);
    expect(addressesEveryone("ally")).toBe(false);
  });
});

describe("mentionHelp", () => {
  it("lists the members plus the two room handles", () => {
    expect(mentionHelp(MEMBERS)).toBe("@acorn, @Blade, @cobalt-dust, @user, @all");
  });
});
