import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolConfig } from "@/lib/pi/tool-categories";

// Mock isConfigured to control sandbox availability
vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: vi.fn(() => false),
}));

// Mock tool factories
vi.mock("@/lib/pi/tools/chat-tools", () => ({
  createChatTools: vi.fn((userId: string) => [
    { name: "chat_search", userId },
    { name: "chat_respond", userId },
    { name: "chat_create", userId },
    { name: "chat_delete", userId },
  ]),
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
    { name: "model_list", userId },
    { name: "job_update", userId },
    { name: "job_delete", userId },
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
    { name: "memory_create", userId },
    { name: "memory_update", userId },
    { name: "memory_delete", userId },
  ]),
}));

vi.mock("@/lib/pi/tools/task-tools", () => ({
  createTaskTools: vi.fn((userId: string) => [
    { name: "task_list", userId },
    { name: "task_create", userId },
  ]),
}));

vi.mock("@/lib/pi/tools/agent-job-tools", () => ({
  createAgentJobTools: vi.fn((userId: string) => [{ name: "agent_job_list", userId }]),
}));

vi.mock("@/lib/pi/tools/infra-tools", () => ({
  createInfraTools: vi.fn((userId: string) => [
    { name: "infra_list_machines", userId },
    { name: "infra_add_machine", userId },
    { name: "infra_remove_machine", userId },
    { name: "infra_exec", userId },
    { name: "infra_read_file", userId },
    { name: "infra_write_file", userId },
    { name: "infra_download_file", userId },
    { name: "infra_upload_file", userId },
    { name: "infra_notes_list", userId },
    { name: "infra_notes_get", userId },
    { name: "infra_notes_upsert", userId },
    { name: "infra_notes_delete", userId },
  ]),
}));

// Feature gating is a database lookup; these cases are about the categories.
const ALL_FEATURES_ON = Object.fromEntries(FEATURES.map((key) => [key, true])) as FeatureMap;
vi.mock("@/lib/permissions/feature-access", () => ({
  loadUserFeatures: vi.fn(async () => ALL_FEATURES_ON),
}));

// Import after mocks
import { resolveTools } from "@/lib/pi/tool-registry";
import { loadUserFeatures } from "@/lib/permissions/feature-access";
import { FEATURES, type FeatureMap } from "@/lib/permissions/features";
import * as sandboxClient from "@/lib/sandbox/client";
import { createWebTools } from "@/lib/pi/tools/web-tools";

describe("resolveTools", () => {
  const mockTerminalTools = {
    read: { name: "read", scope: "terminal" } as unknown as ToolDefinition,
    write: { name: "write", scope: "terminal" } as unknown as ToolDefinition,
    edit: { name: "edit", scope: "terminal" } as unknown as ToolDefinition,
    bash: { name: "bash", scope: "terminal" } as unknown as ToolDefinition,
  };

  const options = {
    createSandboxScopedTools: vi.fn(() => Promise.resolve(mockTerminalTools)),
  };

  const userId = "user-123";
  const sessionId = "session-456";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(false);
  });

  const ALL_OFF: Required<ToolConfig> = {
    terminal: false,
    email: false,
    jobs: false,
    calendar: false,
    chatSearch: false,
    web: false,
    memory: false,
    tasks: false,
    agentJobs: false,
    infra: false,
  };

  it("drops a category whose feature is switched off", async () => {
    vi.mocked(loadUserFeatures).mockResolvedValueOnce({ ...ALL_FEATURES_ON, mail: false });

    const tools = await resolveTools(userId, sessionId, { ...ALL_OFF, email: true }, options);

    expect(tools.map((tool) => tool.name)).not.toContain("mail_list");
  });

  it("makes every resolved tool end when the run is aborted", async () => {
    // Pi awaits tool execution and only checks the abort signal between tool
    // calls, so without wrapping, Stop during a tool waits for that tool.
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ran" }] });
    vi.mocked(createWebTools).mockReturnValueOnce([
      { name: "web_fetch", execute } as unknown as ToolDefinition,
    ]);

    const tools = await resolveTools(userId, sessionId, { ...ALL_OFF, web: true }, options);
    const tool = tools.find((t) => t.name === "web_fetch")!;
    expect(tool).toBeDefined();

    const controller = new AbortController();
    controller.abort();

    // Pi's execute signature demands a full ExtensionContext; the wrapper only
    // cares about the signal.
    const executeTool = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>;

    await expect(executeTool("call-1", {}, controller.signal)).rejects.toThrow("Operation aborted");
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves tool results untouched while the run is alive", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ran" }] });
    vi.mocked(createWebTools).mockReturnValueOnce([
      { name: "web_fetch", execute } as unknown as ToolDefinition,
    ]);

    const tools = await resolveTools(userId, sessionId, { ...ALL_OFF, web: true }, options);
    const tool = tools.find((t) => t.name === "web_fetch")!;

    const executeTool = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<unknown>;
    const result = await executeTool("call-1", { url: "x" }, new AbortController().signal);

    expect(result).toEqual({ content: [{ type: "text", text: "ran" }] });
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { url: "x" },
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
  });

  it("returns empty array when all tools disabled", async () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);
    expect(tools).toHaveLength(0);
  });

  it("includes terminal tools when terminal enabled and configured", async () => {
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5); // read, write, edit, bash, show_file
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
    expect(options.createSandboxScopedTools).toHaveBeenCalledWith(userId, sessionId);
  });

  it("includes no tools when terminal enabled but not configured", async () => {
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(false);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    // Terminal is skipped (not configured), no local fallback
    expect(tools).toHaveLength(0);
  });

  it("backward compat: legacy 'files' key enables terminal tools", async () => {
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);

    const config = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
      files: true, // legacy key
    } as Required<ToolConfig>;

    const tools = await resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
  });

  it("backward compat: legacy 'bash' key enables terminal tools", async () => {
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);

    const config = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
      bash: true, // legacy key
    } as Required<ToolConfig>;

    const tools = await resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "show_file"]);
  });

  it("includes email tools when email enabled", async () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["mail_accounts", "mail_list", "mail_read"]);
  });

  it("includes all custom tools when all enabled", async () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
      tasks: true,
      agentJobs: true,
      infra: true,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    // email(3) + jobs(5) + calendar(2) + chatSearch(4) + web(2) + memory(5) + tasks(2) + agentJobs(1) + infra(12) = 36
    expect(tools).toHaveLength(36);
    expect(tools.map((t) => t.name)).toEqual([
      "mail_accounts",
      "mail_list",
      "mail_read",
      "job_list",
      "job_run",
      "model_list",
      "job_update",
      "job_delete",
      "calendar_list",
      "calendar_create",
      "chat_search",
      "chat_respond",
      "chat_create",
      "chat_delete",
      "web_search",
      "web_fetch",
      "memory_index",
      "memory_search",
      "memory_create",
      "memory_update",
      "memory_delete",
      "task_list",
      "task_create",
      "agent_job_list",
      "infra_list_machines",
      "infra_add_machine",
      "infra_remove_machine",
      "infra_exec",
      "infra_read_file",
      "infra_write_file",
      "infra_download_file",
      "infra_upload_file",
      "infra_notes_list",
      "infra_notes_get",
      "infra_notes_upsert",
      "infra_notes_delete",
    ]);
  });

  it("includes all tools including terminal when everything enabled", async () => {
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
      tasks: true,
      agentJobs: true,
      infra: true,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    // terminal(5) + email(3) + jobs(5) + calendar(2) + chatSearch(4) + web(2) + memory(5) + tasks(2) + agentJobs(1) + infra(12) = 41
    expect(tools).toHaveLength(41);
  });

  it("passes userId to all user-scoped factories", async () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

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

  it("does not include web tools when disabled", async () => {
    const config: Required<ToolConfig> = {
      terminal: false,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    expect(tools.find((t) => t.name === "web_search")).toBeUndefined();
    expect(tools.find((t) => t.name === "web_fetch")).toBeUndefined();
  });

  it("skips terminal category in the registry loop", async () => {
    // This ensures terminal is NOT dispatched through the generic registry loop
    // (it has special handling in the terminal block)
    vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);

    const config: Required<ToolConfig> = {
      terminal: true,
      email: false,
      jobs: false,
      calendar: false,
      chatSearch: false,
      web: false,
      memory: false,
      tasks: false,
      agentJobs: false,
      infra: false,
    };
    const tools = await resolveTools(userId, sessionId, config, options);

    // Should have exactly: read, write, edit, bash, show_file (5 tools)
    // No duplicates from the registry loop
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === "bash")).toHaveLength(1);
    expect(names.filter((n) => n === "read")).toHaveLength(1);
  });

  describe("tool exposure", () => {
    const exposureOf = (tools: ToolDefinition[], name: string) =>
      (tools.find((t) => t.name === name) as { exposure?: string } | undefined)?.exposure;

    const ALL_ON: Required<ToolConfig> = {
      terminal: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
      tasks: true,
      agentJobs: true,
      watchers: true,
      infra: true,
      settings: true,
    };

    it("applies each category's default when the user configured nothing", async () => {
      vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);
      const tools = await resolveTools(userId, sessionId, ALL_ON, options);
      // The read-only tools of a niche catalog are the ones codemode lists, so
      // the model can survey the area before it acts.
      expect(exposureOf(tools, "mail_read")).toBe("codemode");
      expect(exposureOf(tools, "job_list")).toBe("codemode");
      expect(exposureOf(tools, "settings_list")).toBe("codemode");
      // A watcher is a thing the model must know it can look at  its list is
      // listed  while creating one is an action it has to go and find.
      expect(exposureOf(tools, "watcher_list")).toBe("codemode");
      expect(exposureOf(tools, "watcher_create")).toBe("deferred");
      // The rest of the catalog stays callable from a script but unlisted, so
      // it has to be found with `searchTools`.
      expect(exposureOf(tools, "infra_exec")).toBe("deferred");
      expect(exposureOf(tools, "settings_set")).toBe("deferred");
      // The everyday tools stay declared.
      expect(exposureOf(tools, "web_search")).toBeUndefined();
      expect(exposureOf(tools, "memory_search")).toBeUndefined();
      expect(exposureOf(tools, "bash")).toBeUndefined();
      expect(exposureOf(tools, "show_file")).toBeUndefined();
    });

    it("lets a category override its default without touching the others", async () => {
      const tools = await resolveTools(userId, sessionId, ALL_ON, {
        ...options,
        exposure: { email: "direct", infra: "deferred" },
      });

      // email is pulled back in front of the model  the user's choice for the
      // category beats the per-tool split, both listed and unlisted tools.
      expect(exposureOf(tools, "mail_accounts")).toBeUndefined();
      expect(exposureOf(tools, "mail_read")).toBeUndefined();
      // …infra is hidden even from codemode's catalog…
      expect(exposureOf(tools, "infra_exec")).toBe("deferred");
      expect(exposureOf(tools, "infra_list_machines")).toBe("deferred");
      // …and categories the user did not touch keep their default.
      expect(exposureOf(tools, "job_list")).toBe("codemode");
      expect(exposureOf(tools, "web_search")).toBeUndefined();
    });

    it("applies a category's exposure to every tool built for it", async () => {
      // show_file ships with the terminal bundle rather than being built by the
      // chat factory, so this is also a check that the category comes from the
      // shared catalog and not from wherever the tool was constructed.
      vi.mocked(sandboxClient.isConfigured).mockReturnValue(true);
      const tools = await resolveTools(userId, sessionId, ALL_ON, {
        ...options,
        exposure: { terminal: "codemode", chatSearch: "deferred" },
      });

      expect(exposureOf(tools, "bash")).toBe("codemode");
      expect(exposureOf(tools, "read")).toBe("codemode");
      expect(exposureOf(tools, "show_file")).toBe("codemode");
      expect(exposureOf(tools, "chat_search")).toBe("deferred");
      expect(exposureOf(tools, "chat_respond")).toBe("deferred");
    });

    it("leaves tools missing from the catalog direct", async () => {
      vi.mocked(createWebTools).mockReturnValueOnce([
        { name: "not_in_catalog" } as unknown as ToolDefinition,
      ]);
      const tools = await resolveTools(userId, sessionId, ALL_ON, {
        ...options,
        exposure: { web: "codemode" },
      });

      expect(exposureOf(tools, "not_in_catalog")).toBeUndefined();
    });

    it("survives the wrappers applied after resolution", async () => {
      // The approval gate and abort race both spread the definition; a spread
      // that dropped `exposure` would silently retake the context budget.
      const gate = (tool: ToolDefinition) => ({ ...tool, gated: true });
      const tools = await resolveTools(userId, sessionId, ALL_ON, {
        ...options,
        wrapWithApproval: gate,
        exposure: { memory: "codemode" },
      });

      expect(exposureOf(tools, "memory_search")).toBe("codemode");
      expect(tools.find((t) => t.name === "memory_search")).toHaveProperty("gated", true);
    });
  });
});
