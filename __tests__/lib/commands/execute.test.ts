import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `executeCommand` is the one entrypoint both surfaces call, so its job is
 * dispatch and guardrails: unknown commands, commands that don't belong on the
 * surface, arguments that have to be read off the line, and values that must be
 * validated against what the prompt offered (the web route receives them from
 * the client).
 *
 * The catalog and handlers are mocked so the guardrails can be exercised with
 * fixtures instead of the real commands' side effects.
 */

const { CATALOG, CATALOG_BY_NAME, HANDLERS } = vi.hoisted(() => {
  const icon = () => null;
  const catalog = [
    { name: "run-now", description: "immediate", surfaces: ["web", "telegram"], icon },
    { name: "web-only", description: "web only", surfaces: ["web"], icon },
    {
      name: "pick",
      description: "interactive",
      surfaces: ["web", "telegram"],
      icon,
      arguments: [{ name: "time", kind: "choice" as const, description: "When it applies" }],
    },
    {
      name: "draw",
      description: "declares arguments",
      surfaces: ["web"],
      icon,
      arguments: [
        { name: "prompt", kind: "text" as const, required: true, description: "What to draw" },
        { name: "size", kind: "text" as const, description: "Resolution as WxH" },
        { name: "files", kind: "files" as const, required: true, description: "Pictures" },
      ],
    },
    {
      name: "note",
      description: "optional text",
      surfaces: ["web"],
      icon,
      arguments: [
        { name: "body", kind: "text" as const, required: true, description: "What it says" },
      ],
    },
  ];
  return {
    CATALOG: catalog,
    CATALOG_BY_NAME: new Map(catalog.map((meta) => [meta.name, meta])),
    HANDLERS: {
      "run-now": { run: vi.fn() },
      "web-only": { run: vi.fn() },
      pick: { prepare: vi.fn(), run: vi.fn() },
      draw: { run: vi.fn() },
      note: { run: vi.fn() },
    },
  };
});

vi.mock("@/lib/commands/catalog", () => ({
  COMMAND_CATALOG: CATALOG,
  getCommandMeta: (name: string) => CATALOG_BY_NAME.get(name.toLowerCase()),
}));

vi.mock("@/lib/commands/handlers", () => ({ COMMAND_HANDLERS: HANDLERS }));

import { executeCommand } from "@/lib/commands/execute";
import type { CommandFile } from "@/lib/commands/types";

const WEB_CTX = { surface: "web", userId: "u1", sessionId: "s1", args: "", files: [] } as const;
const TELEGRAM_CTX = {
  surface: "telegram",
  userId: "u1",
  args: "",
  files: [],
  sessionId: "sess-1",
  telegramChatId: BigInt(1),
  encryptedToken: "token",
} as const;

const PROMPT = {
  title: "Pick one",
  options: [
    { value: "on", label: "Enable" },
    { value: "stop", label: "Turn off" },
  ],
};

const PICTURES: CommandFile[] = [
  { path: "/home/user/uploads/a.png", fileName: "a.png", mimeType: "image/png", size: 10 },
];

beforeEach(() => {
  vi.clearAllMocks();
  HANDLERS["run-now"].run.mockResolvedValue({ message: "ran", tone: "success" });
  HANDLERS["web-only"].run.mockResolvedValue({ message: "ran", tone: "success" });
  HANDLERS.pick.run.mockResolvedValue({ message: "picked", tone: "success" });
  HANDLERS.pick.prepare.mockResolvedValue(PROMPT);
  HANDLERS.draw.run.mockResolvedValue({ message: "drew", tone: "success" });
  HANDLERS.note.run.mockResolvedValue({ message: "noted", tone: "success" });
});

describe("executeCommand", () => {
  it("rejects a command that is not in the catalog", async () => {
    const result = await executeCommand("nope", WEB_CTX);

    expect(result).toMatchObject({ kind: "error", name: "nope" });
    expect(result.kind === "error" && result.error).toMatch(/Unknown command/);
  });

  it("rejects a command that does not belong on the surface", async () => {
    const result = await executeCommand("web-only", TELEGRAM_CTX);

    expect(result).toMatchObject({ kind: "error" });
    expect(HANDLERS["web-only"].run).not.toHaveBeenCalled();
  });

  it("runs an immediate command and returns its outcome", async () => {
    const result = await executeCommand("run-now", WEB_CTX);

    expect(result).toEqual({
      kind: "done",
      name: "run-now",
      outcome: { message: "ran", tone: "success" },
    });
    expect(HANDLERS["run-now"].run).toHaveBeenCalledWith({ ...WEB_CTX, arguments: {} });
  });

  it("returns the prompt when an interactive command needs a choice", async () => {
    const result = await executeCommand("pick", WEB_CTX);

    expect(result).toEqual({ kind: "prompt", name: "pick", prompt: PROMPT });
    expect(HANDLERS.pick.run).not.toHaveBeenCalled();
  });

  it("runs an interactive command straight away when the argument names an option", async () => {
    const result = await executeCommand("pick", { ...WEB_CTX, args: "stop" });

    expect(result).toMatchObject({ kind: "done" });
    expect(HANDLERS.pick.run).toHaveBeenCalledWith(
      { ...WEB_CTX, args: "stop", arguments: {} },
      "stop",
    );
  });

  it("reads the named form of a choice", async () => {
    await executeCommand("pick", { ...WEB_CTX, args: "time:stop" });

    expect(HANDLERS.pick.run).toHaveBeenCalledWith(expect.anything(), "stop");
    expect(HANDLERS.pick.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { time: "stop" } }),
    );
  });

  it("matches an option by label, case-insensitively", async () => {
    await executeCommand("pick", { ...WEB_CTX, args: "TURN OFF" });

    expect(HANDLERS.pick.run).toHaveBeenCalledWith(expect.anything(), "stop");
  });

  it("rejects an argument that matches no option, listing the alternatives", async () => {
    const result = await executeCommand("pick", { ...WEB_CTX, args: "sideways" });

    expect(result).toMatchObject({ kind: "error" });
    expect(result.kind === "error" && result.error).toMatch(/on, stop/);
    expect(HANDLERS.pick.run).not.toHaveBeenCalled();
  });

  it("validates a value handed in by a surface against the offered options", async () => {
    // The web route passes this straight through from the client.
    const result = await executeCommand("pick", WEB_CTX, "not-an-option");

    expect(result).toMatchObject({ kind: "error" });
    expect(HANDLERS.pick.run).not.toHaveBeenCalled();
  });

  it("hands the handler its named arguments", async () => {
    await executeCommand("draw", {
      ...WEB_CTX,
      args: "prompt:a red fox in the snow size:1536x1024",
      files: PICTURES,
    });

    expect(HANDLERS.draw.run).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { prompt: "a red fox in the snow", size: "1536x1024" },
        files: PICTURES,
      }),
    );
  });

  it("keeps text that names no argument for a positional reader", async () => {
    await executeCommand("note", { ...WEB_CTX, args: "body:hello there" });

    expect(HANDLERS.note.run).toHaveBeenCalledWith(
      expect.objectContaining({ args: "body:hello there", arguments: { body: "hello there" } }),
    );
  });

  it("says which argument is missing, and how the command is written", async () => {
    const result = await executeCommand("draw", { ...WEB_CTX, files: PICTURES });

    expect(result.kind === "error" && result.error).toContain("needs a prompt");
    expect(result.kind === "error" && result.error).toContain(
      "/draw prompt:<text> files:<files> [size:<text>]",
    );
    expect(HANDLERS.draw.run).not.toHaveBeenCalled();
  });

  it("wants the files a command declares before it runs", async () => {
    const result = await executeCommand("draw", { ...WEB_CTX, args: "prompt:a fox" });

    expect(result.kind === "error" && result.error).toContain("needs a files");
    expect(HANDLERS.draw.run).not.toHaveBeenCalled();
  });

  it("reports a handler that throws as an error, not a rejection", async () => {
    HANDLERS["run-now"].run.mockRejectedValue(new Error("The endpoint said no"));

    const result = await executeCommand("run-now", WEB_CTX);

    expect(result).toEqual({ kind: "error", name: "run-now", error: "The endpoint said no" });
  });
});
