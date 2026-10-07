import { describe, it, expect } from "vitest";
import { parseCommand } from "@/lib/commands/parse";

describe("parseCommand", () => {
  it("parses a bare command with no arguments", () => {
    expect(parseCommand("/model")).toEqual({ name: "model", args: "" });
  });

  it("strips the @botname suffix Telegram adds in shared chats", () => {
    expect(parseCommand("/model@SaaleBot")).toEqual({ name: "model", args: "" });
    expect(parseCommand("/stfu@SaaleBot stop")).toEqual({ name: "stfu", args: "stop" });
  });

  it("splits the argument off the name", () => {
    expect(parseCommand("/stfu stop")).toEqual({ name: "stfu", args: "stop" });
    expect(parseCommand("/model   anthropic:claude-sonnet-4")).toEqual({
      name: "model",
      args: "anthropic:claude-sonnet-4",
    });
  });

  it("keeps multi-line arguments intact", () => {
    expect(parseCommand("/model first\nsecond")).toEqual({ name: "model", args: "first\nsecond" });
  });

  it("lowercases the name and trims the input", () => {
    expect(parseCommand("  /MoDeL  ")).toEqual({ name: "model", args: "" });
  });

  it("does not mistake ordinary text for a command", () => {
    expect(parseCommand("what does /model do?")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("does not parse paths or malformed commands", () => {
    expect(parseCommand("/dashboard/chat")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("//model")).toBeNull();
    expect(parseCommand("/model@")).toBeNull();
  });
});
