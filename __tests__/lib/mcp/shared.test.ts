import { describe, it, expect } from "vitest";
import {
  isMcpToolPolicy,
  mcpNameKey,
  mcpServerFromToolName,
  toMcpServerView,
  validateMcpServerName,
  validateMcpUrl,
} from "@/lib/mcp/shared";

describe("MCP server names", () => {
  it("accepts letters, digits, dashes and underscores", () => {
    expect(validateMcpServerName("homeassistant")).toBeNull();
    expect(validateMcpServerName("home-assistant")).toBeNull();
    expect(validateMcpServerName("ha_2")).toBeNull();
  });

  it("rejects characters Pi would rewrite into tool names", () => {
    expect(validateMcpServerName("my server")).not.toBeNull();
    expect(validateMcpServerName("hass.assistant")).not.toBeNull();
    expect(validateMcpServerName("")).not.toBeNull();
    expect(validateMcpServerName("a".repeat(65))).not.toBeNull();
  });

  it("treats dashes and underscores as the same name, like Pi does", () => {
    expect(mcpNameKey("Home-Assistant")).toBe("home_assistant");
    expect(mcpNameKey("home_assistant")).toBe("home_assistant");
  });
});

describe("MCP tool names", () => {
  it("extracts the server segment", () => {
    expect(mcpServerFromToolName("mcp__homeassistant__HassTurnOn")).toBe("homeassistant");
    expect(mcpServerFromToolName("mcp__home_assistant__HassTurnOn")).toBe("home_assistant");
    // Tool names may themselves contain double underscores.
    expect(mcpServerFromToolName("mcp__docs__read__page")).toBe("docs");
  });

  it("returns null for tools that are not MCP tools", () => {
    expect(mcpServerFromToolName("bash")).toBeNull();
    expect(mcpServerFromToolName("mcp__broken")).toBeNull();
    expect(mcpServerFromToolName("mcp____x")).toBeNull();
  });

  it("keys a tool's server the same way as the configured server name", () => {
    const server = mcpServerFromToolName("mcp__home_assistant__HassTurnOn");
    expect(server).not.toBeNull();
    expect(server).toBe(mcpNameKey("home-assistant"));
  });
});

describe("MCP URLs", () => {
  it("accepts http and https endpoints, including LAN hosts", () => {
    expect(validateMcpUrl("https://homeassistant.local:8123/api/mcp")).toBeNull();
    expect(validateMcpUrl("http://192.168.1.10:8123/api/mcp")).toBeNull();
  });

  it("rejects malformed URLs and other schemes", () => {
    expect(validateMcpUrl("not a url")).not.toBeNull();
    expect(validateMcpUrl("ftp://example.com/mcp")).not.toBeNull();
    expect(validateMcpUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateMcpUrl("")).not.toBeNull();
  });
});

describe("MCP tool policies", () => {
  it("recognizes the three stored policies", () => {
    expect(isMcpToolPolicy("ask")).toBe(true);
    expect(isMcpToolPolicy("allow")).toBe(true);
    expect(isMcpToolPolicy("off")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isMcpToolPolicy("auto")).toBe(false);
    expect(isMcpToolPolicy("")).toBe(false);
    expect(isMcpToolPolicy(undefined)).toBe(false);
    expect(isMcpToolPolicy(1)).toBe(false);
  });
});

describe("toMcpServerView", () => {
  const row = {
    id: "srv-1",
    name: "homeassistant",
    url: "https://homeassistant.local:8123/api/mcp",
    description: "Control the smart home",
    encryptedToken: "iv:tag:ciphertext",
    toolPolicy: "allow",
    enabled: true,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-02T09:00:00Z"),
  };

  it("never exposes the encrypted token", () => {
    const view = toMcpServerView(row);
    expect(view.hasToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain("ciphertext");
  });

  it("reports a missing token and the stored policy", () => {
    const view = toMcpServerView({ ...row, encryptedToken: null, toolPolicy: "off" });
    expect(view.hasToken).toBe(false);
    expect(view.toolPolicy).toBe("off");
  });

  it("falls back to ask for a policy it does not understand", () => {
    expect(toMcpServerView({ ...row, toolPolicy: "yolo" }).toolPolicy).toBe("ask");
  });
});
