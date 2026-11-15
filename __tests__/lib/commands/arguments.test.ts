import { describe, it, expect } from "vitest";
import {
  commandUsage,
  missingArgument,
  parseCommandArguments,
  takesFiles,
} from "@/lib/commands/arguments";
import { getCommandMeta } from "@/lib/commands/catalog";
import { Frame } from "lucide-react";
import type { CommandArgument, CommandMeta } from "@/lib/commands/types";

/** A catalog entry with the arguments under test. */
function fixture(name: string, args: readonly CommandArgument[]): CommandMeta {
  return {
    name,
    description: "fixture",
    surfaces: ["web"],
    icon: Frame,
    ...(args.length > 0 ? { arguments: args } : {}),
  };
}

/**
 * The argument line is what a user types after a command name, so this pins the
 * two forms it has to keep working: named (`prompt:a red fox size:1024x1536`)
 * and the positional text the commands started with.
 */

const DECLARED: CommandArgument[] = [
  { name: "prompt", kind: "text", required: true, description: "What to render" },
  { name: "size", kind: "text", description: "Resolution" },
  { name: "time", kind: "choice", description: "When", choices: ["on", "stop"] },
  { name: "files", kind: "files", required: true, description: "Pictures" },
];

describe("parseCommandArguments", () => {
  it("reads nothing out of an empty line", () => {
    expect(parseCommandArguments("", DECLARED)).toEqual({ values: {}, rest: "" });
    expect(parseCommandArguments("   ", DECLARED)).toEqual({ values: {}, rest: "" });
  });

  it("reads a named value, spaces and all", () => {
    expect(parseCommandArguments("prompt:a red fox in the snow", DECLARED)).toEqual({
      values: { prompt: "a red fox in the snow" },
      rest: "",
    });
  });

  it("stops a value at the next declared name", () => {
    expect(parseCommandArguments("prompt:a red fox size:1536x1024", DECLARED)).toEqual({
      values: { prompt: "a red fox", size: "1536x1024" },
      rest: "",
    });
  });

  it("leaves an undeclared name in the prompt", () => {
    expect(parseCommandArguments("prompt:size matters", DECLARED)).toEqual({
      values: { prompt: "size matters" },
      rest: "",
    });
  });

  it("strips quotes around a value", () => {
    expect(parseCommandArguments('prompt:"a red fox" size:1024x1024', DECLARED).values).toEqual({
      prompt: "a red fox",
      size: "1024x1024",
    });
  });

  it("keeps a trailing colon value's own colons intact", () => {
    expect(parseCommandArguments("prompt:a fox", DECLARED).values.prompt).toBe("a fox");
  });

  it("hands positional text back as rest", () => {
    expect(parseCommandArguments("a red fox in the snow", DECLARED)).toEqual({
      values: {},
      rest: "a red fox in the snow",
    });
    expect(parseCommandArguments("1024x1024 a red fox", DECLARED)).toEqual({
      values: {},
      rest: "1024x1024 a red fox",
    });
  });

  it("keeps text written before a named value", () => {
    expect(parseCommandArguments("carefully prompt:a fox", DECLARED)).toEqual({
      values: { prompt: "a fox" },
      rest: "carefully",
    });
  });

  it("ignores a repeated name, keeping the first value", () => {
    expect(
      parseCommandArguments("prompt:first size:1024x1024 prompt:second", DECLARED).values,
    ).toEqual({ prompt: "first", size: "1024x1024" });
  });

  it("reads nothing when the command declares no arguments", () => {
    expect(parseCommandArguments("prompt:a fox", [])).toEqual({
      values: {},
      rest: "prompt:a fox",
    });
  });

  it("matches a name at the start of the line only, not mid-word", () => {
    expect(parseCommandArguments("aprompt:a fox", DECLARED)).toEqual({
      values: {},
      rest: "aprompt:a fox",
    });
  });

  it("reads the declared arguments of a real command", () => {
    const meta = getCommandMeta("edit")!;
    const parsed = parseCommandArguments("prompt:make it night size:1024x1536", meta.arguments);

    expect(parsed.values).toEqual({ prompt: "make it night", size: "1024x1536" });
  });
});

describe("missingArgument", () => {
  const meta = fixture("draw", DECLARED);

  it("names the first required argument with no value", () => {
    expect(missingArgument(meta, {}, [{}])?.name).toBe("prompt");
    expect(missingArgument(meta, { prompt: "a fox" }, [{}])).toBeUndefined();
  });

  it("counts an attached file as the files argument", () => {
    expect(missingArgument(meta, { prompt: "a fox" }, [])?.name).toBe("files");
  });

  it("asks for nothing on a command that declares no arguments", () => {
    expect(missingArgument(fixture("bare", []), {}, [])).toBeUndefined();
  });
});

describe("commandUsage", () => {
  it("shows required arguments before the optional ones", () => {
    expect(commandUsage(fixture("draw", DECLARED))).toBe(
      "/draw prompt:<text> files:<files> [size:<text>] [time:<one>]",
    );
  });

  it("is just the command when it takes no arguments", () => {
    expect(commandUsage(getCommandMeta("compact")!)).toBe("/compact");
  });
});

describe("takesFiles", () => {
  it("knows which commands the composer may attach to", () => {
    expect(takesFiles(getCommandMeta("edit")!)).toBe(true);
    expect(takesFiles(getCommandMeta("image")!)).toBe(false);
  });
});
