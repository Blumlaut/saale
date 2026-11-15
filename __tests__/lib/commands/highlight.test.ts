import { describe, it, expect } from "vitest";
import { commandTokens } from "@/lib/commands/highlight";

/**
 * The highlight is drawn by an invisible mirror of the textarea, so the runs it
 * is given must concatenate back to exactly the text that was typed. Anything
 * else would slide the chips off the words they describe.
 */

const kinds = (tokens: { kind: string; text: string }[]) =>
  tokens.map((t) => `${t.kind}:${t.text}`);

describe("commandTokens", () => {
  it("gives the text back unchanged", () => {
    for (const text of [
      "/image",
      "/image ",
      "/image prompt:a red fox size:1536x1024",
      "/stfu time:permanent",
      "/stop clear:true",
      "  /image prompt:x",
      "/image prompt:a fox\nsize:1024x1024",
    ]) {
      expect(
        commandTokens(text)
          .map((t) => t.text)
          .join(""),
      ).toBe(text);
    }
  });

  it("highlights the command name", () => {
    expect(kinds(commandTokens("/image"))).toEqual(["command:/image"]);
    expect(kinds(commandTokens("/image "))).toEqual(["command:/image", "plain: "]);
  });

  it("marks the argument names and their values", () => {
    expect(kinds(commandTokens("/image prompt:a red fox size:1024x1024"))).toEqual([
      "command:/image",
      "plain: ",
      "label:prompt:",
      "value:a red fox",
      "plain: ",
      "label:size:",
      "value:1024x1024",
    ]);
  });

  it("marks a boolean and a choice the same way as any other value", () => {
    expect(kinds(commandTokens("/stop clear:true"))).toEqual([
      "command:/stop",
      "plain: ",
      "label:clear:",
      "value:true",
    ]);
  });

  it("leaves an empty value to the gap", () => {
    expect(kinds(commandTokens("/image prompt:"))).toEqual([
      "command:/image",
      "plain: ",
      "label:prompt:",
    ]);
  });

  it("keeps free text that names no argument plain", () => {
    expect(kinds(commandTokens("/image a red fox"))).toEqual([
      "command:/image",
      "plain: a red fox",
    ]);
  });

  it("highlights nothing outside a command the catalog knows", () => {
    expect(commandTokens("/nope prompt:x")).toEqual([]);
    expect(commandTokens("/im")).toEqual([]);
    expect(commandTokens("hello")).toEqual([]);
    expect(commandTokens("")).toEqual([]);
    expect(commandTokens("/")).toEqual([]);
  });

  it("highlights nothing after a command that takes no arguments", () => {
    expect(kinds(commandTokens("/compact"))).toEqual(["command:/compact"]);
  });
});
