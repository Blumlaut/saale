import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { extractToolMeta, extractToolMetaBlock } from "@/lib/chat/tool-meta";

const DOUBLED = Type.Object({ input: Type.Integer(), doubled: Type.Integer() });

/** A tool built the way every tool is built: one value, two readers. */
function doublingTool() {
  return defineStructuredTool({
    name: "sample",
    label: "Sample",
    description: "Doubles a number.",
    parameters: Type.Object({ n: Type.Integer() }),
    outputSchema: DOUBLED,
    execute: async (_toolCallId, params) => ({
      value: { input: params.n, doubled: params.n * 2 },
    }),
  });
}

/**
 * The text a result carries once it is stored: the transcript joins text blocks
 * without a separator, so a metadata block brings its own newline.
 */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

describe("defineStructuredTool", () => {
  it("hands the model text and a script the same value", async () => {
    const result = await doublingTool().execute(
      "call-1",
      { n: 21 },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.structuredContent).toEqual({ input: 21, doubled: 42 });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ input: 21, doubled: 42 }, null, 2) },
    ]);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("declares the output schema, which is what makes scripts receive the value", () => {
    expect(doublingTool().outputSchema).toBe(DOUBLED);
  });

  it("tracks the parameters it was called with", async () => {
    const tool = doublingTool();
    const values = await Promise.all(
      [-3, 0, 7].map(async (n) => {
        const result = await tool.execute("call-1", { n }, undefined, undefined, {} as never);
        return result.structuredContent;
      }),
    );

    expect(values).toEqual([
      { input: -3, doubled: -6 },
      { input: 0, doubled: 0 },
      { input: 7, doubled: 14 },
    ]);
  });

  it("keeps UI metadata out of the value, where the console can still read it", async () => {
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Reports with metadata.",
      parameters: Type.Object({ n: Type.Integer() }),
      outputSchema: DOUBLED,
      execute: async (_toolCallId, params) => ({
        value: { input: params.n, doubled: params.n * 2 },
        meta: { _saaleInfraMeta: { type: "sample", machineId: "m-1", stdout: "first line" } },
      }),
    });

    const result = await tool.execute("call-1", { n: 2 }, undefined, undefined, {} as never);
    const text = textOf(result);

    // The value is the tool's finding, not the card the console draws from it.
    expect(result.structuredContent).toEqual({ input: 2, doubled: 4 });
    expect(extractToolMetaBlock(text)?.meta).toMatchObject({ type: "sample", machineId: "m-1" });
    expect(extractToolMeta<{ type?: string; stdout?: string }>(text)?.stdout).toBe("first line");
    expect(JSON.stringify(result.structuredContent)).not.toContain("machineId");

    // One block, as every tool has always produced: the model reads the value
    // and the console's metadata in the same text.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${JSON.stringify({ input: 2, doubled: 4 }, null, 2)}\n{"_saaleInfraMeta":{"type":"sample","machineId":"m-1","stdout":"first line"}}`,
    });
  });

  it("appends the metadata after the text and any extra blocks", async () => {
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Reads an image.",
      parameters: Type.Object({ n: Type.Integer() }),
      outputSchema: DOUBLED,
      execute: async (_toolCallId, params) => ({
        value: { input: params.n, doubled: params.n * 2 },
        text: "read 2 bytes",
        content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        meta: { _saaleInfraMeta: { type: "sample" } },
      }),
    });

    const result = await tool.execute("call-1", { n: 1 }, undefined, undefined, {} as never);

    expect(result.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(result.content[0]).toEqual({ type: "text", text: "read 2 bytes" });
    expect(result.content[2]).toEqual({
      type: "text",
      text: '\n{"_saaleInfraMeta":{"type":"sample"}}',
    });
    // The stored result joins blocks without a separator, so the metadata block
    // carries its own newline.
    expect(textOf(result)).toBe('read 2 bytes\n{"_saaleInfraMeta":{"type":"sample"}}');
    // Custom prose still describes the same value a script reads.
    expect(result.structuredContent).toEqual({ input: 1, doubled: 2 });
  });

  it("normalizes the value to the JSON a script receives, not a live object", async () => {
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Returns a date.",
      parameters: Type.Object({}),
      // The value is unchecked here because the point is what happens to it on
      // the way out: a Date has to become the string a script receives.
      outputSchema: Type.Object({ at: Type.Unknown() }),
      execute: async () => ({ value: { at: new Date("2026-10-08T12:00:00Z") } }),
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);

    expect(result.structuredContent).toEqual({ at: "2026-10-08T12:00:00.000Z" });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("carries a payload that would corrupt a script intact", async () => {
    const payload = [
      "## Notes",
      "```sh",
      `curl "https://x/y?z=1" | jq '.a["b"]'`,
      "```",
      "path: C:\\data\\1 }",
      "`tick`",
    ].join("\n");

    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Returns markdown.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ content: Type.String() }),
      execute: async () => ({ value: { content: payload } }),
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);

    // Byte for byte: quotes, backticks, backslashes and braces all survive.
    expect((result.structuredContent as { content: string }).content).toBe(payload);
    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify({ content: payload })));
  });

  it("carries no details when a tool sets none", async () => {
    const result = await doublingTool().execute(
      "call-1",
      { n: 1 },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toBeUndefined();
  });

  it("carries the details a tool sets", async () => {
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Reports details.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      execute: async () => ({ value: { ok: true }, details: { id: "task-1" } }),
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({ id: "task-1" });
  });

  it("passes the tool call id and signal through to the tool", async () => {
    const controller = new AbortController();
    const seen = { id: "", aborted: false };
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Records its arguments.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      execute: async (toolCallId, _params, signal) => {
        seen.id = toolCallId;
        seen.aborted = signal?.aborted ?? false;
        return { value: { ok: true } };
      },
    });

    await tool.execute("call-9", {}, controller.signal, undefined, {} as never);

    expect(seen).toEqual({ id: "call-9", aborted: false });
  });

  it("reports a failing tool as a failure, not an empty value", async () => {
    const tool = defineStructuredTool({
      name: "sample",
      label: "Sample",
      description: "Fails.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => {
        throw new Error("no machine configured");
      },
    });

    await expect(tool.execute("call-1", {}, undefined, undefined, {} as never)).rejects.toThrow(
      "no machine configured",
    );
  });
});
