import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ redis: new Map<string, string>() }));

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    set: vi.fn(async (key: string, value: string) => {
      store.redis.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.redis.get(key) ?? null),
  }),
}));

import { cacheMcpTools, readCachedMcpTools } from "@/lib/mcp/tool-cache";

describe("MCP tool cache", () => {
  beforeEach(() => store.redis.clear());

  it("keeps the names the model calls a server's tools by", async () => {
    await cacheMcpTools("srv-1", "home assistant", [
      { name: "HassTurnOn", description: "Turn something on" },
      { name: "turn-off", description: null },
    ]);

    expect(await readCachedMcpTools("srv-1")).toEqual([
      {
        name: "mcp__home_assistant__HassTurnOn",
        label: "HassTurnOn",
        description: "Turn something on",
      },
      { name: "mcp__home_assistant__turn_off", label: "turn-off", description: null },
    ]);
  });

  it("reports a server that has not answered yet", async () => {
    expect(await readCachedMcpTools("srv-unknown")).toBeNull();
  });
});
