import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolConfig } from "@/lib/pi/tool-categories";

// Mock isConfigured to control terminal availability
vi.mock("@/lib/terminal/client", () => ({
  isConfigured: vi.fn(() => false),
}));

// Mock tool factories
vi.mock("@/lib/pi/tools/chat-tools", () => ({
  createChatSearchTool: vi.fn((userId: string) => ({
    name: "chat_search",
    userId,
  })),
  createShowFileTool: vi.fn((userId: string, _sessionId: string) => ({
    name: "show_file",
    userId,
  })),
}));

vi.mock("@/lib/pi/tools/mail-tools", () => ({
  createMailTools: vi.fn((userId: string) => [
    { name: "mail_accounts", userId },
    { name: "mail_list", userId },
    { name: "mail_read", userId },
  ]),
}));

vi.mock("@/lib/pi/tools/job-tools", () => ({
  createJobTools: vi.fn((userId: string) => [
    { name: "job_list", userId },
    { name: "job_run", userId },
  ]),
}));

vi.mock("@/lib/pi/tools/calendar-tools", () => ({
  createCalendarTools: vi.fn((userId: string) => [
    { name: "calendar_list", userId },
    { name: "calendar_create", userId },
  ]),
}));

vi.mock("@/lib/pi/tools/web-tools", () => ({
  createWebTools: vi.fn(() => [{ name: "web_search" }, { name: "web_fetch" }]),
}));

vi.mock("@/lib/pi/tools/memory-tools", () => ({
  createMemoryTools: vi.fn((userId: string) => [
    { name: "memory_index", userId },
    { name: "memory_search", userId },
  ]),
}));

// Import after mocks
import { resolveTools } from "@/lib/pi/tool-registry";
import * as terminalClient from "@/lib/terminal/client";

describe("resolveTools", () => {
  const mockTerminalTools = {
    read: { name: "read", scope: "terminal" } as unknown as ToolDefinition,
    write: { name: "write", scope: "terminal" } as unknown as ToolDefinition,
    edit: { name: "edit", scope: "terminal" } as unknown as ToolDefinition,
    bash: { name: "bash", scope: "terminal" } as unknown as ToolDefinition,
  };

  const options = {
    createTerminalScopedTools: vi.fn(() => mockTerminalTools),
  };

  const userId = "user-123";
  const sessionId = "session-456";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(terminalClient.isConfigured).mockReturnValue(false);
  });

  it("returns empty array when all tools disabled", () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);
    expect(tools).toHaveLength(0);
  });

  it("includes terminal tools when terminal enabled and configured", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5); // read, write, edit, bash, show_file
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
    expect(options.createTerminalScopedTools).toHaveBeenCalledWith(userId, sessionId);
  });

  it("includes no tools when terminal enabled but not configured", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(false);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // Terminal is skipped (not configured), no local fallback
    expect(tools).toHaveLength(0);
  });

  it("backward compat: legacy 'files' key enables terminal tools", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      files: true, // legacy key
    } as Required<ToolConfig>;

    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
  });

  it("backward compat: legacy 'bash' key enables terminal tools", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      bash: true, // legacy key
    } as Required<ToolConfig>;

    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
  });

  it("includes email tools when email enabled", () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["mail_accounts", "mail_list", "mail_read"]);
  });

  it("includes all custom tools when all enabled", () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // email(3) + jobs(2) + calendar(2) + chatSearch(1) + web(2) + memory(2) = 12
    expect(tools).toHaveLength(12);
    expect(tools.map((t) => t.name)).toEqual([
      "mail_accounts",
      "mail_list",
      "mail_read",
      "job_list",
      "job_run",
      "calendar_list",
      "calendar_create",
      "chat_search",
      "web_search",
      "web_fetch",
      "memory_index",
      "memory_search",
    ]);
  });

  it("includes all tools including terminal when everything enabled", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // terminal(5) + email(3) + jobs(2) + calendar(2) + chatSearch(1) + web(2) + memory(2) = 17
    expect(tools).toHaveLength(17);
  });

  it("passes userId to all user-scoped factories", () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // Check that all user-scoped tools received the userId
    const mailTools = tools.find((t) => t.name === "mail_accounts");
    expect(mailTools).toHaveProperty("userId", userId);

    const jobTool = tools.find((t) => t.name === "job_list");
    expect(jobTool).toHaveProperty("userId", userId);

    const chatTool = tools.find((t) => t.name === "chat_search");
    expect(chatTool).toHaveProperty("userId", userId);

    const memoryTool = tools.find((t) => t.name === "memory_index");
    expect(memoryTool).toHaveProperty("userId", userId);
  });

  it("does not include web tools when disabled", () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools.find((t) => t.name === "web_search")).toBeUndefined();
    expect(tools.find((t) => t.name === "web_fetch")).toBeUndefined();
  });

  it("skips terminal category in the registry loop", () => {
    // This ensures terminal is NOT dispatched through the generic registry loop
    // (it has special handling in the terminal block)
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // Should have exactly: read, write, edit, bash, show_file (5 tools)
    // No duplicates from the registry loop
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === "bash")).toHaveLength(1);
    expect(names.filter((n) => n === "read")).toHaveLength(1);
  });
});
