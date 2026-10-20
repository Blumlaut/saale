import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  createDiscoveryGlobals,
  toolSample,
  tokenize,
  type DiscoverableTool,
} from "@/lib/pi/codemode-discovery";

/**
 * These are the helpers a watcher script gets from Saale's own sandbox, standing
 * in for the ones Pi registers in a chat's  so what is pinned here is the
 * surface a script sees (`searchTools`, `describeTool`, `describeNamespace`,
 * their arguments and their errors), not the sandbox around it.
 */

function tool(overrides: Partial<DiscoverableTool> & { name: string }): DiscoverableTool {
  return {
    description: `Does ${overrides.name}`,
    parameters: { type: "object", properties: {} },
    ...overrides,
  };
}

const TOOLS: DiscoverableTool[] = [
  tool({
    name: "mail_send",
    description: "Send an email from the user's mailbox",
    parameters: {
      type: "object",
      properties: { subject: { type: "string", description: "Subject line" } },
    },
  }),
  tool({
    name: "mail_list",
    description: "List recent email in a folder",
    parameters: { type: "object", properties: { folder: { type: "string" } } },
  }),
  tool({
    name: "watcher_create",
    description: "Create a script watcher",
    parameters: {
      type: "object",
      properties: { cronExpression: { type: "string", description: "When to tick" } },
    },
  }),
  tool({ name: "my-tool", description: "A tool whose name is not an identifier" }),
  tool({
    name: "docs_search",
    description: "Search the documentation server",
    namespace: {
      name: "mcp__docs",
      // What Pi's MCP extension sets: the server's own name, for `describeNamespace("docs")`.
      aliases: ["docs"],
      description: "The documentation server",
      instructions: "Call docs_search before writing about the API.",
    },
  }),
];

/** The text a script reads for each tool, exactly as the runner builds it. */
const SAMPLES = new Map(TOOLS.map((candidate) => [candidate.name, toolSample(candidate)]));

/**
 * Call a global the way a script does: spread arguments, over one tool set  the
 * same pairing `runner.ts` builds for the sandbox.
 */
function callWith(tools: readonly DiscoverableTool[]) {
  const globals = createDiscoveryGlobals(
    tools,
    new Map(tools.map((candidate) => [candidate.name, toolSample(candidate)])),
  );
  return async (name: string, ...args: unknown[]): Promise<unknown> => {
    const global = globals.find((candidate) => candidate.name === name);
    if (!global) throw new Error(`No global named ${name}`);
    return await global.execute(args, { signal: new AbortController().signal });
  };
}

const call = callWith(TOOLS);

describe("tokenize", () => {
  it("splits at camelCase and non-alphanumerics and stems plurals", () => {
    expect(tokenize("InfraExec: issues on prod-1")).toEqual([
      "infra",
      "exec",
      "issue",
      "prod",
      "1",
    ]);
  });

  it("drops stop words", () => {
    expect(tokenize("search the mail for a subject")).toEqual(["search", "mail", "subject"]);
  });
});

describe("toolSample", () => {
  it("carries the description and the declaration a script calls it by", () => {
    const sample = SAMPLES.get("mail_send") ?? "";

    expect(sample).toContain("Send an email from the user's mailbox");
    expect(sample).toContain("mail_send(args");
  });
});

describe("searchTools", () => {
  it("ranks a tool whose words match the query first", async () => {
    const found = (await call("searchTools", "send an email")) as { name: string }[];

    expect(found[0]?.name).toBe("mail_send");
    expect(found.map((match) => match.name)).toContain("mail_list");
  });

  it("returns entries a script can call and describe", async () => {
    const [found] = (await call("searchTools", "send email")) as {
      name: string;
      description: string;
    }[];

    expect(found?.description).toBe(SAMPLES.get("mail_send"));
  });

  it("names a tool by its script identifier, and finds it by the raw name too", async () => {
    const found = (await call("searchTools", "not an identifier")) as { name: string }[];

    expect(found[0]?.name).toBe("my_tool");
    await expect(call("describeTool", "my_tool")).resolves.toBe(SAMPLES.get("my-tool"));
  });

  it("matches a parameter's name and description, not just the tool's own words", async () => {
    const found = (await call("searchTools", "cron expression")) as { name: string }[];

    expect(found[0]?.name).toBe("watcher_create");
  });

  it("answers a query that matches nothing with an empty list", async () => {
    await expect(call("searchTools", "zzzz")).resolves.toEqual([]);
    await expect(call("searchTools", "the a of it")).resolves.toEqual([]);
  });

  it("returns eight matches unless the script asks for another number", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      tool({ name: `bulk_${index}`, description: "Bulk operation on items" }),
    );
    const bulk = callWith(many);

    expect(await bulk("searchTools", "bulk")).toHaveLength(DEFAULT_TOOL_SEARCH_LIMIT);
    expect(await bulk("searchTools", "bulk", { limit: 3 })).toHaveLength(3);
    expect(await bulk("searchTools", "bulk", { limit: 20 })).toHaveLength(12);
  });

  it("rejects a query or limit that is not usable", async () => {
    await expect(call("searchTools", 42)).rejects.toThrow("expects a query string");
    for (const limit of [0, -1, 1.5]) {
      await expect(call("searchTools", "bulk", { limit })).rejects.toThrow(
        "limit must be a positive integer",
      );
    }
    await expect(call("searchTools", "bulk", { namespace: 7 })).rejects.toThrow(
      "namespace must be a string",
    );
  });
});

describe("describeTool", () => {
  it("returns the tool's text by name", async () => {
    await expect(call("describeTool", "mail_list")).resolves.toBe(SAMPLES.get("mail_list"));
  });

  it("returns undefined for a tool it does not have", async () => {
    await expect(call("describeTool", "nope")).resolves.toBeUndefined();
  });

  it("rejects a name that is not a string", async () => {
    await expect(call("describeTool", { name: "mail_list" })).rejects.toThrow(
      "expects a tool name",
    );
  });
});

describe("describeNamespace", () => {
  it("returns the namespace's description, instructions and tools", async () => {
    await expect(call("describeNamespace", "mcp__docs")).resolves.toEqual({
      name: "mcp__docs",
      description: "The documentation server",
      instructions: "Call docs_search before writing about the API.",
      tools: ["docs_search"],
    });
  });

  it("accepts an alias of a namespace name", async () => {
    const byAlias = await call("describeNamespace", "docs");

    expect(byAlias).toMatchObject({ name: "mcp__docs" });
  });

  it("matches an alias the namespace name does not spell out", async () => {
    const dev = callWith([
      tool({
        name: "dev_search",
        description: "Search the dev server",
        namespace: { name: "mcp__dev_radius", aliases: ["dev-radius"] },
      }),
    ]);

    await expect(dev("describeNamespace", "dev-radius")).resolves.toEqual({
      name: "mcp__dev_radius",
      tools: ["dev_search"],
    });
    await expect(dev("describeNamespace", "dev_radius")).resolves.toMatchObject({
      name: "mcp__dev_radius",
    });
  });

  it("does not invent a short name for a namespace without aliases", async () => {
    const bare = callWith([
      tool({
        name: "other_search",
        description: "Search another server",
        namespace: { name: "mcp__other" },
      }),
    ]);

    await expect(bare("describeNamespace", "mcp__other")).resolves.toMatchObject({
      name: "mcp__other",
    });
    await expect(bare("describeNamespace", "other")).resolves.toBeUndefined();
  });

  it("returns undefined for a namespace that does not exist", async () => {
    await expect(call("describeNamespace", "mcp__nope")).resolves.toBeUndefined();
    await expect(call("describeNamespace", 1)).rejects.toThrow("expects a namespace name");
  });
});

describe("searchTools with a namespace", () => {
  it("searches only the given namespace", async () => {
    const found = (await call("searchTools", "search docs", { namespace: "mcp__docs" })) as {
      name: string;
    }[];

    expect(found.map((match) => match.name)).toEqual(["docs_search"]);
  });

  it("takes an alias as the namespace to search", async () => {
    const found = (await call("searchTools", "search docs", { namespace: "docs" })) as {
      name: string;
    }[];

    expect(found.map((match) => match.name)).toEqual(["docs_search"]);
  });

  it("finds nothing in a namespace no tool belongs to", async () => {
    await expect(call("searchTools", "search", { namespace: "mcp__nope" })).resolves.toEqual([]);
  });
});
