import { describe, it, expect, vi } from "vitest";
import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { ALL_TOOL_INFOS, CODEMODE_TOOL_NAME, findToolInfo } from "@/lib/pi/tool-infos";
import {
  CODEMODE_INLINE_BUDGET,
  DEFAULT_TOOL_EXPOSURE,
  type ToolExposure,
} from "@/lib/pi/tool-categories";
import { createChatTools, createShowFileTool } from "@/lib/pi/tools/chat-tools";
import { createMailTools } from "@/lib/pi/tools/mail-tools";
import { createContactTools } from "@/lib/pi/tools/contact-tools";
import { createJobTools } from "@/lib/pi/tools/job-tools";
import { createCalendarTools } from "@/lib/pi/tools/calendar-tools";
import { createWebTools } from "@/lib/pi/tools/web-tools";
import { createMemoryTools } from "@/lib/pi/tools/memory-tools";
import { createTaskTools } from "@/lib/pi/tools/task-tools";
import { createAgentJobTools } from "@/lib/pi/tools/agent-job-tools";
import { createWatcherTools } from "@/lib/pi/tools/watcher-tools";
import { createTelegramTools } from "@/lib/pi/tools/telegram-tools";
import { createInfraTools } from "@/lib/pi/tools/infra-tools";
import { createSettingsTools } from "@/lib/settings/tools";
import { createProjectTools } from "@/lib/coder/tools";
import { CODER_TOOL_DEFAULTS } from "@/lib/pi/coder-tools";
import { createSandboxScopedTools } from "@/lib/pi/session";

// The terminal tools are Pi built-ins wrapped by Saale; building them must not
// reach for the database (or a sandbox) to learn their names.
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnv: vi.fn(async () => ({})) }));

/** Pi built-ins the registry ships without a Saale factory. */
const PI_BUILTIN_TOOL_NAMES = [CODEMODE_TOOL_NAME];

/**
 * Every tool a factory can build for a session, as definitions rather than
 * names.
 *
 * The workspace bundle (`read`/`write`/`edit`/`bash`) is built through the same
 * factory `resolveTools` uses rather than hard-coded here, so a rewiring that
 * drops one of them fails this test instead of being assumed present.
 */
async function implementedTools(): Promise<ToolDefinition[]> {
  const userId = "catalog-user";
  const sessionId = "catalog-session";
  const terminal = await createSandboxScopedTools(userId, sessionId);

  const bundles: Array<ToolDefinition | ToolDefinition[]> = [
    Object.values(terminal),
    createChatTools(userId, sessionId),
    createShowFileTool(userId, sessionId),
    createMailTools(userId),
    createContactTools(userId),
    createJobTools(userId),
    createCalendarTools(userId),
    createWebTools(),
    createMemoryTools(userId),
    createTaskTools(userId),
    createAgentJobTools(userId),
    createWatcherTools(userId, sessionId),
    createTelegramTools(userId, sessionId),
    createInfraTools(userId),
    createProjectTools(userId),
    createSettingsTools(userId),
  ];

  return bundles.flatMap((bundle) => (Array.isArray(bundle) ? bundle : [bundle]));
}

/** Every tool name the registry can declare, Pi's `codemode` included. */
async function implementedToolNames(): Promise<string[]> {
  return [...PI_BUILTIN_TOOL_NAMES, ...(await implementedTools()).map((tool) => tool.name)];
}

/**
 * The catalog drives the settings UI, the approval gate and the share-redaction
 * rules, so a tool advertised there but never implemented shows a policy toggle
 * the user can set to no effect  the drift that hid `memory_delete`.
 */
describe("tool catalog ↔ implementation drift", () => {
  it("never advertises a tool that no factory implements", async () => {
    const implemented = new Set(await implementedToolNames());
    const phantom = ALL_TOOL_INFOS.map((info) => info.name).filter(
      (name) => !implemented.has(name),
    );
    expect(
      phantom,
      "Implement these in src/lib/pi/tools/ or drop them from ALL_TOOL_INFOS",
    ).toEqual([]);
  });

  it("names every implemented tool in the catalog", async () => {
    const catalog = new Set(ALL_TOOL_INFOS.map((info) => info.name));
    const unlisted = [...new Set(await implementedToolNames())].filter(
      (name) => !catalog.has(name),
    );
    expect(unlisted, "Add these to ALL_TOOL_INFOS in src/lib/pi/tool-infos.ts").toEqual([]);
  });

  it("has no duplicate catalog names", () => {
    const names = ALL_TOOL_INFOS.map((info) => info.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every tool of a codemode category a listed-or-hidden decision", () => {
    const undecided = ALL_TOOL_INFOS.filter((info) => {
      const category = info.category;
      if (!category || DEFAULT_TOOL_EXPOSURE[category] !== "codemode") return false;
      return info.defaultExposure !== "codemode" && info.defaultExposure !== "deferred";
    });
    expect(
      undecided.map((info) => info.name),
      'Set `defaultExposure` on these in ALL_TOOL_INFOS: "codemode" to list the tool in the codemode catalog, "deferred" to leave it to searchTools',
    ).toEqual([]);
  });

  it("never lists a tool that has to be confirmed", () => {
    // The catalog is what the model reads without looking; a tool the user has
    // to approve is an action, and an action is something to go and find.
    const listedAndGuarded = ALL_TOOL_INFOS.filter(
      (info) => info.defaultPolicy === "ask" && info.defaultExposure === "codemode",
    );
    expect(listedAndGuarded.map((info) => info.name)).toEqual([]);
  });

  it("lists only what the chat was given", async () => {
    // A coder chat starts with terminal, web, memory and settings: the catalog
    // it is handed must not advertise (or spend tokens on) the rest.
    const callable = (await implementedTools()).filter((tool) => {
      const info = findToolInfo(tool.name);
      const category = info?.category;
      if (!category) return false;
      return CODER_TOOL_DEFAULTS[category] && defaultExposureOf(tool.name) !== "direct";
    });

    const listed = [...(await listedToolNames(callable))];
    expect(listed.length).toBeGreaterThan(0);

    const offCategory = listed.filter((name) => {
      const category = findToolInfo(name)?.category;
      return !category || !CODER_TOOL_DEFAULTS[category];
    });
    expect(
      offCategory,
      "a coder chat's codemode catalog must only hold tools of the categories it has",
    ).toEqual([]);
    expect(listed).not.toContain("mail_send");
    expect(listed).not.toContain("calendar_create");
  });

  it("lists the read-only entry points of every area", async () => {
    const listed = await listedToolNames();
    // The regression this guards: the codemode budget filled with whichever
    // tools had the shortest descriptions, which dropped the entry points and
    // left `watcher_delete` advertised with no sign of what a watcher is.
    expect([...listed].sort()).toEqual([
      "agent_job_list",
      "agent_job_logs",
      "agent_job_run_messages",
      "calendar_list",
      "calendar_search",
      "calendar_upcoming",
      "chat_search",
      "contacts_list",
      "contacts_search",
      "infra_download_file",
      "infra_list_machines",
      "infra_notes_get",
      "infra_notes_list",
      "infra_read_file",
      "job_list",
      "job_logs",
      "job_types",
      "mail_accounts",
      "mail_folders",
      "mail_list",
      "mail_read",
      "mail_search",
      "model_list",
      "project_list",
      "project_settings_get",
      "settings_list",
      "task_list_pending",
      "task_search",
      "watcher_get",
      "watcher_list",
      "watcher_ticks",
    ]);
  });
});

/** The exposure the resolver gives a tool when the user changed nothing. */
function defaultExposureOf(name: string): ToolExposure {
  const info = findToolInfo(name);
  const category = info?.category;
  if (!category) return "direct";
  // Mirrors `applyToolExposure`: no default anywhere leaves the tool declared.
  return info?.defaultExposure ?? DEFAULT_TOOL_EXPOSURE[category] ?? "direct";
}

/**
 * The tools codemode lists to the model, rendered by Pi's own catalog.
 *
 * Pi builds that description in `prepareLoadout`, which a session calls whenever
 * the active tools change, so the check runs the real renderer  including its
 * token budget  rather than a re-implementation of it that could not fail.
 */
async function listedToolNames(tools?: ToolDefinition[]): Promise<Set<string>> {
  const exposureOf = defaultExposureOf;
  const callable =
    tools ?? (await implementedTools()).filter((t) => exposureOf(t.name) !== "direct");

  let registered: ToolDefinition | undefined;
  createCodemodeExtension({ inlineBudget: CODEMODE_INLINE_BUDGET })({
    // Registration reads only these members; the rest of ExtensionAPI is never
    // reached, so the stub stands in for a session that will never exist here.
    registerTool: (tool: ToolDefinition) => {
      registered = tool;
    },
    getSettings: () => ({}),
    getAllTools: () => [],
    appendEntry: () => {},
  } as unknown as ExtensionAPI);

  if (!registered?.prepareLoadout) throw new Error("codemode registered no loadout hook");

  const loadout: ToolLoadout = {
    // No declared tools: the catalog lists what is reachable from a script, and
    // the declared ones are excluded from it by exposure either way.
    declared: [],
    callable: callable as unknown as ToolLoadout["callable"],
    registered: callable as unknown as ToolLoadout["registered"],
    getExposure: (name) => exposureOf(name),
    getNamespace: () => undefined,
    getPromptGuidelines: () => [],
  };

  const description = registered.prepareLoadout(loadout)?.descriptions?.[CODEMODE_TOOL_NAME];
  if (!description) throw new Error("codemode rendered no catalog");

  return new Set(
    [...description.matchAll(/^### `([A-Za-z0-9_]+)`/gm)].map((match) => match[1] ?? ""),
  );
}
