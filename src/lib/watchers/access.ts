/**
 * The tools a watcher script may reach.
 *
 * The tick runs the script with this set and nothing else, and a script the
 * user writes in the dialog is tested against the same one.
 */

import { prisma } from "@/lib/db";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveTools } from "@/lib/pi/tool-registry";
import { createSandboxScopedTools } from "@/lib/pi/session";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import { resolveToolPolicy } from "@/lib/pi/tool-policy";
import { CODEMODE_TOOL_NAME } from "@/lib/pi/tool-infos";

/** The user's per-tool policies, as `AppSettings.toolPolicies` stores them. */
export type ToolPolicies = Record<string, string> | null | undefined;

export interface WatcherToolAccess {
  /** Tools the script may call. everything enabled except what the user turned off. */
  callable: Awaited<ReturnType<typeof resolveTools>>;
  callableNames: string[];
  toolPolicies: ToolPolicies;
}

/**
 * The tools a script may call, and their names.
 *
 * Everything the user has enabled, minus whatever they set to `off`: a tool the
 * user turned off is absent, so a script cannot reach it. `codemode` is absent
 * too. a script cannot start a script.
 *
 * Exposure is deliberately not consulted. It governs how a *model* reaches a
 * tool, and a watcher has no model in the loop. the script is the only caller.
 */
export function watcherToolAccess(options: {
  tools: readonly ToolDefinition[];
  toolPolicies: ToolPolicies;
}): { callable: ToolDefinition[]; callableNames: string[] } {
  const callable = options.tools.filter(
    (tool) =>
      tool.name !== CODEMODE_TOOL_NAME &&
      resolveToolPolicy(tool.name, { toolPolicies: options.toolPolicies }) !== "off",
  );
  return { callable, callableNames: callable.map((tool) => tool.name) };
}

/**
 * Resolve the watcher tool set for a user.
 *
 * `scopeId` is what the tools are scoped to. A watcher bound to a conversation
 * passes that conversation, so a script acting on chats is held to the same "a
 * chat may not respond to itself" rule a conversation is; an unbound watcher
 * passes its own id.
 *
 * The user's enabled categories decide which tools exist here. the same setting
 * a conversation uses.
 */
export async function loadWatcherToolAccess(
  userId: string,
  scopeId: string,
): Promise<WatcherToolAccess> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true, toolPolicies: true },
  });

  const toolPolicies: ToolPolicies =
    (settings?.toolPolicies as Record<string, string> | null) ?? null;

  const toolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...((settings?.defaultToolConfig as Record<string, boolean>) ?? {}),
  } as Required<ToolConfig>;

  const tools = await resolveTools(userId, scopeId, toolConfig, {
    createSandboxScopedTools,
  });

  const { callable, callableNames } = watcherToolAccess({ tools, toolPolicies });

  return { callable, callableNames, toolPolicies };
}
