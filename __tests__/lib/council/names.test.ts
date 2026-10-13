import { describe, expect, it } from "vitest";
import { MEMBER_NAME_POOL, pickMemberName, pickMemberNames } from "@/lib/council/names";
import { isValidMemberName } from "@/lib/council/mentions";
import { MAX_MEMBERS } from "@/lib/council/config";

/** A deterministic stand-in for Math.random. */
const constant = (value: number) => () => value;

describe("member name pool", () => {
  it("holds only usable handles, without duplicates", () => {
    expect(MEMBER_NAME_POOL.length).toBeGreaterThan(500);
    expect(new Set(MEMBER_NAME_POOL).size).toBe(MEMBER_NAME_POOL.length);
    for (const name of MEMBER_NAME_POOL) {
      expect(isValidMemberName(name), `${name} is not a usable handle`).toBe(true);
      // A handle is one token: the parser stops at anything else.
      expect(name).toMatch(/^[a-z]+$/);
    }
  });
});

describe("pickMemberName", () => {
  it("draws from the pool and stays clear of names already in use", () => {
    const taken = MEMBER_NAME_POOL.slice(0, 30);
    for (let i = 0; i < 50; i += 1) {
      const name = pickMemberName(taken);
      expect(MEMBER_NAME_POOL).toContain(name);
      expect(taken).not.toContain(name);
    }
  });

  it("compares taken names case-insensitively, as mentions resolve", () => {
    // Every draw that lands on the first free word must still avoid "ACORN".
    const taken = MEMBER_NAME_POOL.filter((name) => name !== "acorn").concat("ACORN");
    expect(pickMemberName(taken, constant(0))).not.toBe("acorn");
  });

  it("is deterministic for a given random source", () => {
    expect(pickMemberName([], constant(0))).toBe(MEMBER_NAME_POOL[0]);
    expect(pickMemberName([], constant(0.5))).toBe(
      MEMBER_NAME_POOL[Math.floor(0.5 * MEMBER_NAME_POOL.length)],
    );
    expect(pickMemberName([], constant(0.999999))).toBe(
      MEMBER_NAME_POOL[MEMBER_NAME_POOL.length - 1],
    );
  });

  it("skips taken names when the draw lands on one", () => {
    // The first free word, not the pool's first word.
    const taken = MEMBER_NAME_POOL.slice(0, 10);
    expect(pickMemberName(taken, constant(0))).toBe(MEMBER_NAME_POOL[10]);
  });

  it("falls back to a numbered name when the whole pool is taken", () => {
    const taken = [...MEMBER_NAME_POOL, "acorn-2", "acorn-3"];
    const name = pickMemberName(taken, constant(0));
    expect(name).toMatch(/^[a-z]+-\d+$/);
    expect(name).not.toBe("acorn-2");
    expect(name).not.toBe("acorn-3");
    expect(isValidMemberName(name)).toBe(true);
  });

  it("gives a full council distinct names", () => {
    const names = pickMemberNames(MAX_MEMBERS);
    expect(names).toHaveLength(MAX_MEMBERS);
    expect(new Set(names).size).toBe(MAX_MEMBERS);
  });

  it("never repeats a name for a council that already has members", () => {
    const existing = ["acorn", "blade"];
    const names = pickMemberNames(6, existing);
    expect(names.filter((name) => existing.includes(name))).toEqual([]);
    expect(new Set(names).size).toBe(6);
  });
});
