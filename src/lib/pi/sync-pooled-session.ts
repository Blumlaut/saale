import {
  get as getPooledSession,
  getPoolKey,
  markRebuildPending,
  remove,
} from "@/lib/pi/agent-pool";

/**
 * Apply a settings change to the chat's live agent session, when one is pooled.
 *
 * The pool holds one `AgentSession` per chat, and its model, thinking level and
 * tool loadout are fixed when it is built. Without this, a change made in the
 * UI would only take effect once that session was evicted. up to 30 minutes
 * idle, or a restart. so the chat kept answering with the previous model.
 *
 * Model, thinking level and tool config all live in the session the resource
 * loader built, and the system prompt names the model in the commit trailer.
 * So every change drops the session and the next message rebuilds it: Pi's own
 * `setModel()` swaps the model but leaves the prompt naming the previous one.
 * The transcript stays on disk, so a rebuild resumes the whole conversation.
 *
 * Never while a run is in flight: eviction disposes the session and would abort
 * it. That session is marked instead, and the next eviction pass rebuilds it.
 * The change is in the row either way, so the rebuild picks it up.
 *
 * Shared by the session PATCH route (the header's model/thinking/tool controls)
 * and the `/model` command, so both take effect on the next message.
 */
export async function syncPooledAgentSession(options: {
  userId: string;
  sessionId: string;
  previous: {
    modelProvider: string | null;
    modelName: string | null;
    thinkingLevel: string;
    toolConfig: unknown;
  };
  updated: {
    modelProvider: string | null;
    modelName: string | null;
    thinkingLevel: string;
    toolConfig: unknown;
  };
}): Promise<void> {
  const { userId, sessionId, previous, updated } = options;
  const pooled = getPooledSession(getPoolKey(userId, sessionId));
  if (!pooled) return;

  const modelChanged =
    previous.modelProvider !== updated.modelProvider || previous.modelName !== updated.modelName;
  const levelChanged = previous.thinkingLevel !== updated.thinkingLevel;
  const toolsChanged = JSON.stringify(previous.toolConfig) !== JSON.stringify(updated.toolConfig);
  if (!modelChanged && !levelChanged && !toolsChanged) return;

  if (pooled.session.isStreaming || pooled.promptInFlight) {
    markRebuildPending(getPoolKey(userId, sessionId));
    console.warn(
      `Settings changed during a run of chat session ${sessionId}. Rebuilding it on the next eviction pass.`,
    );
    return;
  }

  await remove(getPoolKey(userId, sessionId));
}
