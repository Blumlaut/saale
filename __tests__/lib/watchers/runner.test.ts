import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyStoreWrites, isFiring, runWatcherScript } from "@/lib/watchers/runner";

/**
 * The runner is the one place a watcher script actually executes, and it runs
 * the real QuickJS sandbox — not a stub. These cases pin the contract a script
 * author depends on: it sees its tools, it sees its store, and `undefined`
 * means "nothing to report".
 */

/** A tool that echoes its input, standing in for Saale's own tools. */
function echoTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Echo ${name}`,
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_toolCallId: string, params: { value: string }) => ({
      content: [{ type: "text" as const, text: `echo:${params.value}` }],
      details: undefined,
    }),
  };
}

/** A tool that fails, so the script sees an Error it can catch. */
function failingTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Always fails`,
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text" as const, text: "boom" }],
      details: undefined,
      isError: true,
    }),
  };
}

describe("runWatcherScript", () => {
  it("runs a script that calls a tool and returns its result", async () => {
    const result = await runWatcherScript({
      script: "const r = await tools.mail_list({ value: 'inbox' });\nreturn r;",
      tools: [echoTool("mail_list")],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("echo:inbox");
    expect(result.callCount).toBe(1);
  });

  it("reports a value from an unawaited-batch script without waking the agent", async () => {
    const result = await runWatcherScript({
      script: "await tools.mail_list({ value: 'a' });\nreturn undefined;",
      tools: [echoTool("mail_list")],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(isFiring(result.value)).toBe(false);
  });

  it("reads values written by the previous tick through store/load", async () => {
    const result = await runWatcherScript({
      script: "const seen = load('seen') ?? 0;\nstore('seen', seen + 1);\nreturn seen;",
      tools: [],
      store: { seen: 41 },
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(41);
    expect(result.storeWrites.set).toEqual({ seen: 42 });
  });

  it("lets a script catch a failing tool instead of failing the tick", async () => {
    const result = await runWatcherScript({
      script: [
        "try {",
        "  await tools.oops({});",
        "  return 'unreachable';",
        "} catch (err) {",
        "  return `caught:${err.message}`;",
        "}",
      ].join("\n"),
      tools: [failingTool("oops")],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("caught:boom");
    expect(result.callCount).toBe(1);
  });

  it("fails the tick when the script throws, keeping partial output", async () => {
    const result = await runWatcherScript({
      script: "text('before the failure');\nthrow new Error('nope');",
      tools: [],
      store: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nope");
    expect(result.output).toContain("before the failure");
  });

  it("does not expose host capabilities to the script", async () => {
    const result = await runWatcherScript({
      script: "return [typeof fetch, typeof require, typeof process, typeof setTimeout];",
      tools: [],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  it("refuses a script that can never settle rather than hanging the tick", async () => {
    const result = await runWatcherScript({
      script: "await new Promise(() => {});",
      tools: [],
      store: {},
    });

    // Timers do not exist in the sandbox, so a bare pending promise is provably
    // deadlocked — the sandbox says so instead of waiting out the deadline.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("can never settle");
  });

  it("aborts a tick that is stuck in a tool when the deadline fires", async () => {
    const hanging: ToolDefinition = {
      name: "hang",
      label: "hang",
      description: "Never resolves until aborted",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };

    const result = await runWatcherScript({
      script: "await tools.hang({});",
      tools: [hanging],
      store: {},
      signal: AbortSignal.timeout(250),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aborted|timeout/i);
  });
});

describe("applyStoreWrites", () => {
  it("merges writes over the previous store and honors deletes", () => {
    const next = applyStoreWrites({ keep: 1, drop: 2 }, { set: { added: 3 }, delete: ["drop"] });

    expect(next).toEqual({ keep: 1, added: 3 });
  });

  it("lets a set in the same tick win over a delete", () => {
    expect(applyStoreWrites({ a: 1 }, { set: { a: 2 }, delete: ["a"] })).toEqual({ a: 2 });
  });
});

describe("isFiring", () => {
  it("treats only a declined report as not firing", () => {
    expect(isFiring(undefined)).toBe(false);
    expect(isFiring(null)).toBe(false);
    expect(isFiring(false)).toBe(false);

    expect(isFiring(true)).toBe(true);
    expect(isFiring(0)).toBe(true);
    expect(isFiring("")).toBe(true);
    expect(isFiring([])).toBe(true);
    expect(isFiring({ any: "value" })).toBe(true);
  });
});
