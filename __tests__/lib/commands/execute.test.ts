import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `executeCommand` is the one entrypoint both surfaces call, so its job is
 * dispatch and guardrails: unknown commands, commands that don't belong on the
 * surface, and values that must be validated against what the prompt offered
 * (the web route receives them from the client).
 *
 * The catalog and handlers are mocked so the guardrails can be exercised with
 * fixtures instead of the real commands' side effects.
 */

const { CATALOG, CATALOG_BY_NAME, HANDLERS } = vi.hoisted(() => {
  const icon = () => null;
  const catalog = [
    { name: "run-now", description: "immediate", surfaces: ["web", "telegram"], icon },
    { name: "web-only", description: "web only", surfaces: ["web"], icon },
    { name: "pick", description: "interactive", surfaces: ["web", "telegram"], icon },
  ];
  return {
    CATALOG: catalog,
    CATALOG_BY_NAME: new Map(catalog.map((meta) => [meta.name, meta])),
    HANDLERS: {
      "run-now": { run: vi.fn() },
      "web-only": { run: vi.fn() },
      pick: { prepare: vi.fn(), run: vi.fn() },
    },
  };
});

vi.mock("@/lib/commands/catalog", () => ({
  COMMAND_CATALOG: CATALOG,
  getCommandMeta: (name: string) => CATALOG_BY_NAME.get(name.toLowerCase()),
}));

vi.mock("@/lib/commands/handlers", () => ({ COMMAND_HANDLERS: HANDLERS }));

import { executeCommand } from "@/lib/commands/execute";

const WEB_CTX = { surface: "web", userId: "u1", sessionId: "s1", args: "" } as const;
const PROMPT = {
  title: "Pick one",
  options: [
    { value: "on", label: "Enable" },
    { value: "stop", label: "Turn off" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  HANDLERS["run-now"].run.mockResolvedValue({ message: "ran", tone: "success" });
  HANDLERS["web-only"].run.mockResolvedValue({ message: "ran", tone: "success" });
  HANDLERS.pick.run.mockResolvedValue({ message: "picked", tone: "success" });
  HANDLERS.pick.prepare.mockResolvedValue(PROMPT);
});

describe("executeCommand", () => {
  it("rejects a command that is not in the catalog", async () => {
    const result = await executeCommand("nope", WEB_CTX);

    expect(result).toMatchObject({ kind: "error", name: "nope" });
    expect(result.kind === "error" && result.error).toMatch(/Unknown command/);
  });

  it("rejects a command that does not belong on the surface", async () => {
    const result = await executeCommand("web-only", {
      surface: "telegram",
      userId: "u1",
      args: "",
      sessionId: "sess-1",
      telegramChatId: BigInt(1),
      encryptedToken: "token",
    });

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
    expect(HANDLERS["run-now"].run).toHaveBeenCalledWith(WEB_CTX);
  });

  it("returns the prompt when an interactive command needs a choice", async () => {
    const result = await executeCommand("pick", WEB_CTX);

    expect(result).toEqual({ kind: "prompt", name: "pick", prompt: PROMPT });
    expect(HANDLERS.pick.run).not.toHaveBeenCalled();
  });

  it("runs an interactive command straight away when the argument names an option", async () => {
    const result = await executeCommand("pick", { ...WEB_CTX, args: "stop" });

    expect(result).toMatchObject({ kind: "done" });
    expect(HANDLERS.pick.run).toHaveBeenCalledWith({ ...WEB_CTX, args: "stop" }, "stop");
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

  it("applies a valid value handed in by a surface", async () => {
    const result = await executeCommand("pick", WEB_CTX, "on");

    expect(result).toMatchObject({ kind: "done" });
    expect(HANDLERS.pick.run).toHaveBeenCalledWith(WEB_CTX, "on");
  });

  it("turns a handler failure into an error result instead of throwing", async () => {
    HANDLERS["run-now"].run.mockRejectedValue(new Error("provider exploded"));

    const result = await executeCommand("run-now", WEB_CTX);

    expect(result).toEqual({ kind: "error", name: "run-now", error: "provider exploded" });
  });

  it("ignores the case of the command name", async () => {
    await executeCommand("RUN-NOW", WEB_CTX);

    expect(HANDLERS["run-now"].run).toHaveBeenCalled();
  });
});
