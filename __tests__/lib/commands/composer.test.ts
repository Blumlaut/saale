import { describe, it, expect } from "vitest";
import { argumentHints, commandReady, readCommandDraft } from "@/lib/commands/composer";
import { getCommandMeta } from "@/lib/commands/catalog";

/**
 * The composer's argument menu follows the caret: it offers the names after
 * `/image `, that argument's values inside a choice, and nothing at all while a
 * free-text value is being typed. The completion range it reports is what the
 * picker replaces, so an off-by-one here would eat the user's text.
 */

const image = getCommandMeta("image");
const edit = getCommandMeta("edit");
const stfu = getCommandMeta("stfu");

describe("readCommandDraft", () => {
  it("splits a command and its arguments", () => {
    expect(readCommandDraft("/image")).toEqual({ name: "image", args: "" });
    expect(readCommandDraft("/image ")).toEqual({ name: "image", args: "" });
    expect(readCommandDraft("/image prompt:a fox")).toEqual({
      name: "image",
      args: "prompt:a fox",
    });
  });

  it("lowercases the name", () => {
    expect(readCommandDraft("/IMAGE prompt:x")).toEqual({ name: "image", args: "prompt:x" });
  });

  it("ignores anything that is not a command", () => {
    expect(readCommandDraft("hello")).toBeNull();
    expect(readCommandDraft("/")).toBeNull();
    // A leading space still reaches the command: `parseCommand` trims too.
    expect(readCommandDraft(" /image")).toEqual({ name: "image", args: "" });
  });
});

describe("commandReady", () => {
  it("is true once the required arguments are filled in", () => {
    expect(commandReady(getCommandMeta("image"), "prompt:a fox")).toBe(true);
    expect(commandReady(getCommandMeta("image"), "")).toBe(false);
    expect(commandReady(getCommandMeta("image"), "size:1024x1024")).toBe(false);
  });

  it("counts an attached picture as the required files argument", () => {
    expect(commandReady(getCommandMeta("edit"), "prompt:make it night", 0)).toBe(false);
    expect(commandReady(getCommandMeta("edit"), "prompt:make it night", 1)).toBe(true);
  });

  it("is true for a command with nothing required", () => {
    expect(commandReady(getCommandMeta("stop"), "")).toBe(true);
    expect(commandReady(getCommandMeta("compact"), "")).toBe(true);
  });
});

describe("argumentHints", () => {
  it("lists the arguments a command declares", () => {
    const completion = argumentHints(image, "");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["prompt:", "size:"]);
    expect(completion?.hints[0]).toMatchObject({ note: "required", kind: "text" });
    expect(completion?.hints[1]).toMatchObject({ note: "optional" });
  });

  it("narrows the list to the typed prefix, replacing only that token", () => {
    const completion = argumentHints(image, "si");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["size:"]);
    expect(completion?.replace).toEqual({ start: 0, end: 2 });
  });

  it("offers the files argument the picker fills in", () => {
    const completion = argumentHints(edit, "", 2);
    const files = completion?.hints.find((hint) => hint.kind === "files");

    expect(files).toMatchObject({ insert: "", attached: 2 });
  });

  it("drops an argument once it has a value", () => {
    const completion = argumentHints(image, "prompt:a fox ");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["size:"]);
    expect(completion?.replace).toEqual({ start: 13, end: 13 });
  });

  it("offers a choice's values, replacing what is typed after the colon", () => {
    const completion = argumentHints(stfu, "time:");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["on", "permanent", "stop"]);
    expect(completion?.replace).toEqual({ start: 5, end: 5 });
  });

  it("stops offering once a choice is written out", () => {
    expect(argumentHints(stfu, "time:permanent")).toBeNull();
  });

  it("says nothing while a free-text value is being typed", () => {
    expect(argumentHints(image, "prompt:a red fox")).toBeNull();
    expect(argumentHints(image, "size:1024")).toBeNull();
  });

  it("says nothing when every argument is filled in", () => {
    expect(argumentHints(image, "prompt:a fox size:1024x1024 ")).toBeNull();
  });

  it("offers both values of a boolean", () => {
    const completion = argumentHints(getCommandMeta("stop"), "clear:");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["true", "false"]);
    expect(completion?.replace).toEqual({ start: 6, end: 6 });
  });

  it("narrows a boolean to the typed prefix, and stops once it is written", () => {
    expect(argumentHints(getCommandMeta("stop"), "clear:f")?.hints.map((h) => h.insert)).toEqual([
      "false",
    ]);
    expect(argumentHints(getCommandMeta("stop"), "clear:false")).toBeNull();
  });

  it("says nothing for a command that declares no arguments", () => {
    expect(argumentHints(getCommandMeta("compact"), "")).toBeNull();
    expect(argumentHints(undefined, "")).toBeNull();
  });

  it("keeps the position right after a newline", () => {
    const completion = argumentHints(image, "prompt:a fox\nsi");

    expect(completion?.replace).toEqual({ start: 13, end: 15 });
  });
});
