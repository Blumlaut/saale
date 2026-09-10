import { describe, it, expect, vi } from "vitest";
import { TOOL_ABORT_MESSAGE, withAbortSignal } from "@/lib/pi/tool-abort";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * The SDK's execute signature requires a full ExtensionContext and typed
 * content blocks. These tests exercise the wrapper, so a loose local signature
 * is used instead of fabricating SDK internals.
 */
type LooseExecute = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<unknown>;

/** A tool whose execution the test controls. */
function makeTool(execute: LooseExecute): ToolDefinition {
  return {
    name: "slow_tool",
    label: "Slow",
    description: "Does something slow.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute,
  } as unknown as ToolDefinition;
}

/** Invoke a wrapped tool the way Pi's loop does. */
function call(
  tool: ToolDefinition,
  signal?: AbortSignal,
  params: unknown = {},
  onUpdate?: unknown,
): Promise<unknown> {
  return (tool.execute as unknown as LooseExecute)("call-1", params, signal, onUpdate, undefined);
}

/** A promise plus its resolver, for tools that would run until told otherwise. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withAbortSignal", () => {
  it("passes results and arguments through when nothing is aborted", async () => {
    const controller = new AbortController();
    const execute = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "done" }], details: {} });
    const tool = withAbortSignal(makeTool(execute));
    const onUpdate = vi.fn();

    const result = await call(tool, controller.signal, { a: 1 }, onUpdate);

    expect(result).toEqual({ content: [{ type: "text", text: "done" }], details: {} });
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { a: 1 },
      controller.signal,
      onUpdate,
      undefined,
    );
    expect(tool.name).toBe("slow_tool");
    expect(tool.description).toBe("Does something slow.");
  });

  it("does not interfere when the tool gets no signal", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    const tool = withAbortSignal(makeTool(execute));

    await call(tool, undefined);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects with Pi's cancellation message when the tool is aborted mid-run", async () => {
    const controller = new AbortController();
    const pending = deferred<{ content: unknown[]; details: unknown }>();
    const tool = withAbortSignal(makeTool(() => pending.promise));

    const execution = call(tool, controller.signal);
    controller.abort();

    await expect(execution).rejects.toThrow(TOOL_ABORT_MESSAGE);
    await expect(execution.catch((err: Error) => err.name)).resolves.toBe("AbortError");
  });

  it("rejects without running the tool when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    const tool = withAbortSignal(makeTool(execute));

    await expect(call(tool, controller.signal)).rejects.toThrow(TOOL_ABORT_MESSAGE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("propagates a genuine tool failure unchanged", async () => {
    const controller = new AbortController();
    const tool = withAbortSignal(makeTool(() => Promise.reject(new Error("disk on fire"))));

    await expect(call(tool, controller.signal)).rejects.toThrow("disk on fire");
  });

  it("reports a tool that fails after the run was aborted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const controller = new AbortController();
      const pending = deferred<{ content: unknown[]; details: unknown }>();
      const tool = withAbortSignal(makeTool(() => pending.promise));

      const execution = call(tool, controller.signal);
      controller.abort();
      await expect(execution).rejects.toThrow(TOOL_ABORT_MESSAGE);

      // The tool kept running; its late failure must not vanish silently.
      pending.reject(new Error("late failure"));
      await new Promise((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledWith(
        'Tool "slow_tool" failed after the run was aborted:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stops listening to the signal once the tool finishes", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const tool = withAbortSignal(makeTool(() => Promise.resolve({ content: [], details: {} })));

    await call(tool, controller.signal);

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
