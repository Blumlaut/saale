import { describe, it, expect, vi } from "vitest";
import { ALL_TOOL_INFOS, CODEMODE_TOOL_NAME } from "@/lib/pi/tool-infos";
import { createChatTools, createShowFileTool } from "@/lib/pi/tools/chat-tools";
import { createMailTools } from "@/lib/pi/tools/mail-tools";
import { createJobTools } from "@/lib/pi/tools/job-tools";
import { createCalendarTools } from "@/lib/pi/tools/calendar-tools";
import { createWebTools } from "@/lib/pi/tools/web-tools";
import { createMemoryTools } from "@/lib/pi/tools/memory-tools";
import { createTaskTools } from "@/lib/pi/tools/task-tools";
import { createAgentJobTools } from "@/lib/pi/tools/agent-job-tools";
import { createInfraTools } from "@/lib/pi/tools/infra-tools";
import { createSettingsTools } from "@/lib/settings/tools";
import { createTerminalScopedTools } from "@/lib/pi/session";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// The terminal tools are Pi built-ins wrapped by Saale; building them must not
// reach for a GitHub token (or a database) to learn their names.
vi.mock("@/lib/github", () => ({ getGitHubEnv: vi.fn(async () => null) }));

/** Pi built-ins the registry ships without a Saale factory. */
const PI_BUILTIN_TOOL_NAMES = [CODEMODE_TOOL_NAME];

/**
 * Every tool name the registry can actually declare to a session.
 *
 * The terminal bundle (`read`/`write`/`edit`/`bash`) is built through the same
 * factory `resolveTools` uses rather than hard-coded here, so a rewiring that
 * drops one of them fails this test instead of being assumed present.
 */
async function implementedToolNames(): Promise<string[]> {
  const userId = "catalog-user";
  const sessionId = "catalog-session";
  const from = (tools: ToolDefinition | ToolDefinition[]) =>
    (Array.isArray(tools) ? tools : [tools]).map((t) => t.name);
  const terminal = await createTerminalScopedTools(userId, sessionId);

  return [
    ...PI_BUILTIN_TOOL_NAMES,
    ...from(Object.values(terminal)),
    ...from(createChatTools(userId, sessionId)),
    ...from(createShowFileTool(userId, sessionId)),
    ...from(createMailTools(userId)),
    ...from(createJobTools(userId)),
    ...from(createCalendarTools(userId)),
    ...from(createWebTools()),
    ...from(createMemoryTools(userId)),
    ...from(createTaskTools(userId)),
    ...from(createAgentJobTools(userId)),
    ...from(createInfraTools(userId)),
    ...from(createSettingsTools(userId)),
  ];
}

/**
 * The catalog drives the settings UI, the approval gate and the share-redaction
 * rules, so a tool advertised there but never implemented shows a policy toggle
 * the user can set to no effect — the drift that hid `memory_delete`.
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
});
