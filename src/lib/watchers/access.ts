/**
 * The tools a watcher script may reach, resolved once for every caller that has
 * to know: the tick that runs the script, the preview that shows the user what
 * it would be allowed to call, and the tools that create it.
 *
 * All three must agree. A preview computed from a different tool set than the
 * tick's would show the user a consent list that does not describe what runs.
 */

import { prisma } from "@/lib/db";
import { resolveTools } from "@/lib/pi/tool-registry";
import { createSandboxScopedTools } from "@/lib/pi/session";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import { watcherToolAccess, type ToolPolicies } from "./grant";

export interface WatcherToolAccess {
  /** Tools the script may call. everything enabled except what the user turned off. */
  callable: Awaited<ReturnType<typeof resolveTools>>;
  callableNames: string[];
  toolPolicies: ToolPolicies;
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
 * a conversation uses. Exposure is not consulted: it governs how a *model*
 * reaches a tool, and a watcher has no model in the loop.
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
