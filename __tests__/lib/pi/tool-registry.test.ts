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
  createShowFileTool: vi.fn((userId: string) => ({
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
    { name: "task_list", userId },
    { name: "task_run", userId },
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
  const mockLocalTools = {
    read: { name: "read", scope: "local" } as unknown as ToolDefinition,
    write: { name: "write", scope: "local" } as unknown as ToolDefinition,
    edit: { name: "edit", scope: "local" } as unknown as ToolDefinition,
  };

  const mockTerminalTools = {
    read: { name: "read", scope: "terminal" } as unknown as ToolDefinition,
    write: { name: "write", scope: "terminal" } as unknown as ToolDefinition,
    edit: { name: "edit", scope: "terminal" } as unknown as ToolDefinition,
    bash: { name: "bash", scope: "terminal" } as unknown as ToolDefinition,
  };

  const options = {
    createLocalScopedTools: vi.fn(() => mockLocalTools),
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
      bash: false,
      files: false,
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

  it("includes only file tools when only files enabled", () => {
    const config: Required<ToolConfig> = {
      bash: false,
      files: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit"]);
    expect(options.createLocalScopedTools).toHaveBeenCalledWith(userId);
    expect(options.createTerminalScopedTools).not.toHaveBeenCalled();
  });

  it("includes bash + file tools when both enabled and terminal configured", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      bash: true,
      files: true,
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
    expect(options.createLocalScopedTools).not.toHaveBeenCalled();
  });

  it("falls back to local tools when bash enabled but terminal not configured", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(false);

    const config: Required<ToolConfig> = {
      bash: true,
      files: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // Bash is skipped (terminal not configured), only local file tools
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit"]);
    expect(options.createLocalScopedTools).toHaveBeenCalledWith(userId);
  });

  it("includes bash-only tools when bash enabled but files disabled (terminal configured)", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      bash: true,
      files: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(2); // bash, show_file
    expect(tools.map((t) => t.name)).toEqual(["bash", "show_file"]);
  });

  it("includes email tools when email enabled", () => {
    const config: Required<ToolConfig> = {
      bash: false,
      files: false,
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
      bash: false,
      files: false,
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
      "task_list",
      "task_run",
      "calendar_list",
      "calendar_create",
      "chat_search",
      "web_search",
      "web_fetch",
      "memory_index",
      "memory_search",
    ]);
  });

  it("includes all tools including bash/files when everything enabled", () => {
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      bash: true,
      files: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
    };
    const tools = resolveTools(userId, sessionId, config, options);

    // bash+files(5) + email(3) + jobs(2) + calendar(2) + chatSearch(1) + web(2) + memory(2) = 17
    expect(tools).toHaveLength(17);
  });

  it("passes userId to all user-scoped factories", () => {
    const config: Required<ToolConfig> = {
      bash: false,
      files: false,
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

    const taskTool = tools.find((t) => t.name === "task_list");
    expect(taskTool).toHaveProperty("userId", userId);

    const chatTool = tools.find((t) => t.name === "chat_search");
    expect(chatTool).toHaveProperty("userId", userId);

    const memoryTool = tools.find((t) => t.name === "memory_index");
    expect(memoryTool).toHaveProperty("userId", userId);
  });

  it("does not include web tools when disabled", () => {
    const config: Required<ToolConfig> = {
      bash: false,
      files: false,
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

  it("skips bash/files categories in the registry loop", () => {
    // This ensures bash/files are NOT dispatched through the generic registry loop
    // (they have special handling in the bash/files block)
    vi.mocked(terminalClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      bash: true,
      files: true,
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
