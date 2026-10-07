import { describe, it, expect } from "vitest";
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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Pi built-ins the registry ships without a Saale factory. */
const PI_BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", CODEMODE_TOOL_NAME];

/** Every tool name the registry can actually declare to a session. */
function implementedToolNames(): string[] {
  const userId = "catalog-user";
  const sessionId = "catalog-session";
  const from = (tools: ToolDefinition | ToolDefinition[]) =>
    (Array.isArray(tools) ? tools : [tools]).map((t) => t.name);

  return [
    ...PI_BUILTIN_TOOL_NAMES,
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
  const catalogNames = ALL_TOOL_INFOS.map((info) => info.name).sort();
  const implementedNames = [...new Set(implementedToolNames())].sort();

  it("never advertises a tool that no factory implements", () => {
    const phantom = catalogNames.filter((name) => !implementedNames.includes(name));
    expect(
      phantom,
      "Implement these in src/lib/pi/tools/ or drop them from ALL_TOOL_INFOS",
    ).toEqual([]);
  });

  it("names every implemented tool in the catalog", () => {
    const unlisted = implementedNames.filter((name) => !catalogNames.includes(name));
    expect(unlisted, "Add these to ALL_TOOL_INFOS in src/lib/pi/tool-infos.ts").toEqual([]);
  });

  it("has no duplicate catalog names", () => {
    const names = ALL_TOOL_INFOS.map((info) => info.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
