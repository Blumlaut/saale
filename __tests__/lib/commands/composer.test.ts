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
const model = getCommandMeta("model");
const stop = getCommandMeta("stop");

const modelOptions = {
  name: [
    { value: "opencode-go:qwen4-max", label: "Qwen4 Max" },
    { value: "anthropic:claude-sonnet-4", label: "Claude Sonnet 4" },
  ],
};

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
    const completion = argumentHints(edit, "", { attached: 2 });
    const files = completion?.hints.find((hint) => hint.kind === "files");

    expect(files).toMatchObject({ insert: "", attached: 2 });
  });

  it("drops an argument once it has a value", () => {
    const completion = argumentHints(image, "prompt:a fox ");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["size:"]);
    expect(completion?.replace).toEqual({ start: 13, end: 13 });
  });

  it("offers the values the server listed for a dynamic choice", () => {
    const completion = argumentHints(image, "size:", {
      options: {
        size: [
          { value: "1024x1024", label: "1024 × 1024 · square", description: "The model's default" },
          { value: "1024x1536", label: "1024 × 1536 · portrait" },
        ],
      },
    });

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["1024x1024", "1024x1536"]);
    expect(completion?.hints[0]).toMatchObject({
      description: "The model's default",
      note: "size",
      target: "value",
    });
    expect(completion?.hints[1]).toMatchObject({ description: "1024 × 1536 · portrait" });
  });

  it("narrows the listed values to the typed part, anywhere in the value", () => {
    const completion = argumentHints(image, "size:1024x1", {
      options: {
        size: [
          { value: "1024x1024", label: "square" },
          { value: "1024x1536", label: "portrait" },
        ],
      },
    });

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["1024x1024", "1024x1536"]);
    expect(completion?.replace).toEqual({ start: 5, end: 11 });

    const middle = argumentHints(model, "name:qwen", { options: modelOptions });
    expect(middle?.hints.map((hint) => hint.insert)).toEqual(["opencode-go:qwen4-max"]);
    expect(middle?.replace).toEqual({ start: 5, end: 9 });
  });

  it("says nothing for a dynamic choice the server has not answered for yet", () => {
    expect(argumentHints(image, "size:")).toBeNull();
    expect(argumentHints(image, "size:1024", { options: { size: [] } })).toBeNull();
  });

  it("offers a choice's values with what each one does", () => {
    const completion = argumentHints(stfu, "time:");

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["on", "permanent", "stop"]);
    expect(completion?.hints[0]).toMatchObject({
      description: "Auto-accept for 2 hours",
      note: "time",
    });
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

  it("completes the first argument's values from a bare word", () => {
    const completion = argumentHints(model, "qwen", { options: modelOptions });

    expect(completion?.hints.map((hint) => hint.insert)).toEqual(["name:opencode-go:qwen4-max"]);
    expect(completion?.hints[0]).toMatchObject({ note: "name", target: "value", kind: "choice" });
    expect(completion?.replace).toEqual({ start: 0, end: 4 });
  });

  it("completes static choices and booleans from a bare word too", () => {
    expect(argumentHints(stfu, "perm")?.hints.map((hint) => hint.insert)).toEqual([
      "time:permanent",
    ]);
    expect(argumentHints(stop, "tr")?.hints.map((hint) => hint.insert)).toEqual(["clear:true"]);
    // The bare word still needs its argument name, so a full value is offered.
    expect(argumentHints(stfu, "stop")?.hints.map((hint) => hint.insert)).toEqual(["time:stop"]);
  });

  it("prefers an argument name the bare word starts with", () => {
    expect(argumentHints(stfu, "t")?.hints.map((hint) => hint.insert)).toEqual(["time:"]);
  });

  it("offers the next choice once the text argument is filled", () => {
    const completion = argumentHints(image, "prompt:a fox 1024", {
      options: {
        size: [
          { value: "1024x1024", label: "square" },
          { value: "1024x1536", label: "portrait" },
        ],
      },
    });

    expect(completion?.hints.map((hint) => hint.insert)).toEqual([
      "size:1024x1024",
      "size:1024x1536",
    ]);
    expect(completion?.replace).toEqual({ start: 13, end: 17 });
  });

  it("keeps free text free while the first argument is text", () => {
    expect(argumentHints(image, "a red fox")).toBeNull();
    expect(
      argumentHints(image, "1024", {
        options: { size: [{ value: "1024x1024", label: "square" }] },
      }),
    ).toBeNull();
  });

  it("says nothing when a bare word matches no value", () => {
    expect(argumentHints(model, "zzz", { options: modelOptions })).toBeNull();
  });
});
