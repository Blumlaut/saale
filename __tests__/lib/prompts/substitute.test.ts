import { describe, expect, it } from "vitest";

import { parsePromptArgs, substitutePromptArgs } from "@/lib/prompts/substitute";

describe("parsePromptArgs", () => {
  it("splits on whitespace", () => {
    expect(parsePromptArgs("src/lib app.ts")).toEqual(["src/lib", "app.ts"]);
  });

  it("keeps a quoted run together", () => {
    expect(parsePromptArgs(`"API compatibility" 'two words'`)).toEqual([
      "API compatibility",
      "two words",
    ]);
  });

  it("keeps an empty quoted argument", () => {
    expect(parsePromptArgs(`a "" b`)).toEqual(["a", "", "b"]);
  });

  it("returns nothing for an empty or blank string", () => {
    expect(parsePromptArgs("")).toEqual([]);
    expect(parsePromptArgs("   ")).toEqual([]);
  });
});

describe("substitutePromptArgs", () => {
  const args = ["one", "two", "three"];

  it("fills positional placeholders", () => {
    expect(substitutePromptArgs("$1 and $2", args)).toBe("one and two");
  });

  it("fills a missing positional with nothing", () => {
    expect(substitutePromptArgs("[$4]", args)).toBe("[]");
  });

  it("joins every argument for $@ and $ARGUMENTS", () => {
    expect(substitutePromptArgs("$@", args)).toBe("one two three");
    expect(substitutePromptArgs("$ARGUMENTS", args)).toBe("one two three");
  });

  it("falls back to a default only when the value is empty", () => {
    expect(substitutePromptArgs("${1:-default}", args)).toBe("one");
    expect(substitutePromptArgs("${4:-default}", args)).toBe("default");
    expect(substitutePromptArgs("${@:-none}", [])).toBe("none");
  });

  it("slices arguments bash-style", () => {
    expect(substitutePromptArgs("${@:2}", args)).toBe("two three");
    expect(substitutePromptArgs("${@:2:1}", args)).toBe("two");
    expect(substitutePromptArgs("${@:0}", args)).toBe("one two three");
  });

  it("leaves text without placeholders alone", () => {
    expect(substitutePromptArgs("Review the diff.", args)).toBe("Review the diff.");
  });

  it("does not substitute inside argument values", () => {
    expect(substitutePromptArgs("$1", ["$2", "two"])).toBe("$2");
  });
});
