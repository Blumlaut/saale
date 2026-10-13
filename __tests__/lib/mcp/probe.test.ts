import { afterEach, describe, expect, it } from "vitest";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server";
import { describeProbeError, probeMcpServer } from "@/lib/mcp/probe";

describe("probeMcpServer", () => {
  let fake: FakeMcpServer | null = null;

  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it("performs the handshake and reports the tools", async () => {
    fake = await startFakeMcpServer({
      instructions: "Controls the house.",
      tools: [
        { name: "HassTurnOn", description: "Turn something on" },
        { name: "HassLightSet", description: "Set a light" },
      ],
    });

    const result = await probeMcpServer({ url: fake.url });

    expect(result.serverName).toBe("fake-home-assistant");
    expect(result.serverVersion).toBe("2.1.0");
    expect(result.instructions).toBe("Controls the house.");
    expect(result.tools).toEqual([
      { name: "HassTurnOn", description: "Turn something on" },
      { name: "HassLightSet", description: "Set a light" },
    ]);
  });

  it("sends the stored token as a bearer header", async () => {
    fake = await startFakeMcpServer({ requireToken: "ha-token" });

    const result = await probeMcpServer({ url: fake.url, token: "ha-token" });

    expect(result.serverName).toBe("fake-home-assistant");
    expect(fake.requests.every((request) => request.authorization === "Bearer ha-token")).toBe(
      true,
    );
  });

  it("fails with a readable error when the token is rejected", async () => {
    fake = await startFakeMcpServer({ requireToken: "right-token" });

    await expect(probeMcpServer({ url: fake.url, token: "wrong-token" })).rejects.toThrow();
    await probeMcpServer({ url: fake.url, token: "wrong-token" }).catch((err) => {
      expect(describeProbeError(err)).toContain("401");
    });
  });

  it("names OAuth as the reason when the server advertises it", async () => {
    fake = await startFakeMcpServer({
      requireToken: "some-token",
      challenge:
        'Bearer realm="mcp", resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource"',
    });

    const message = await probeMcpServer({ url: fake.url }).catch((err) => describeProbeError(err));
    expect(message).toContain("OAuth");
    expect(message).toContain("Sign in");
  });

  it("keeps a plain 401 a token problem", async () => {
    fake = await startFakeMcpServer({ requireToken: "some-token" });

    const message = await probeMcpServer({ url: fake.url, token: "wrong" }).catch((err) =>
      describeProbeError(err),
    );
    expect(message).toContain("401");
    expect(message).not.toContain("OAuth");
  });

  it("fails when nothing is listening", async () => {
    await expect(probeMcpServer({ url: "http://127.0.0.1:1/api/mcp" })).rejects.toThrow();
  });
});

describe("describeProbeError", () => {
  it("includes the HTTP status an MCP client reports", () => {
    const error = Object.assign(new Error("MCP server returned 401"), { status: 401 });
    expect(describeProbeError(error)).toBe("MCP server returned 401 (HTTP 401)");
  });

  it("falls back to the message, and to a string for non-errors", () => {
    expect(describeProbeError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
    expect(describeProbeError("boom")).toBe("boom");
  });
});
