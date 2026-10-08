import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
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

/**
 * A tool that declares an `outputSchema` and returns a value — the shape every
 * Saale tool now has.
 */
function valueTool(
  name: string,
  value: JsonValue,
  extra: { isError?: boolean; text?: string } = {},
): ToolDefinition {
  return {
    name,
    label: name,
    description: `Returns ${name}'s value`,
    parameters: Type.Object({}),
    outputSchema: Type.Object({}, { additionalProperties: true }),
    execute: async () => ({
      content: [{ type: "text" as const, text: extra.text ?? JSON.stringify(value, null, 2) }],
      details: undefined,
      structuredContent: value,
      ...(extra.isError ? { isError: true } : {}),
    }),
  };
}

/** A tool that sets `structuredContent` without declaring an output schema. */
function undeclaredValueTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: "Sets a value it never declared",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text" as const, text: "the text a script should get" }],
      details: undefined,
      structuredContent: { sneaky: true },
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

describe("what a script receives from a tool call", () => {
  it("gives the value to a tool that declares an output schema", async () => {
    const result = await runWatcherScript({
      script: [
        "const r = await tools.health({});",
        "return `exit=${r.exitCode} out=${r.stdout}`;",
      ].join("\n"),
      tools: [valueTool("health", { exitCode: 1, stdout: "down", command: "curl health" })],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("exit=1 out=down");
  });

  it("hands over the value even when the call failed", async () => {
    // Pi's rule: a tool that declared a schema hands its value back for error
    // results too, so a predicate can read a failed check instead of catching it.
    const result = await runWatcherScript({
      script: "const r = await tools.health({});\nreturn r.state;",
      tools: [valueTool("health", { state: "degraded" }, { isError: true, text: "check failed" })],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("degraded");
  });

  it("gives the text to a tool that never declared a schema", async () => {
    const result = await runWatcherScript({
      script: "return String(await tools.legacy({}));",
      tools: [undeclaredValueTool("legacy")],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("the text a script should get");
  });

  it("falls back to the text when a declared value is missing", async () => {
    const tool = valueTool("half", {});
    const withoutValue: ToolDefinition = {
      ...tool,
      execute: async () => ({
        content: [{ type: "text" as const, text: "no value here" }],
        details: undefined,
      }),
    };

    const result = await runWatcherScript({
      script: "return String(await tools.half({}));",
      tools: [withoutValue],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("no value here");
  });

  it("rejects when a tool without a declared value fails", async () => {
    const result = await runWatcherScript({
      script:
        "try { await tools.oops({}); return 'unreachable'; } catch (err) { return `caught:${err.message}`; }",
      tools: [failingTool("oops")],
      store: {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe("caught:boom");
  });
});
