import { buildModelRuntime } from "@/lib/pi/models";
import { isPiThinkingLevel } from "@/lib/pi/thinking-levels";
import { get as getPooledSession, getPoolKey, remove } from "@/lib/pi/agent-pool";

/**
 * Apply a settings change to the chat's live agent session, when one is pooled.
 *
 * The pool holds one `AgentSession` per chat, and its model, thinking level and
 * tool loadout are fixed when it is built. Without this, a change made in the
 * UI would only take effect once that session was evicted. up to 30 minutes
 * idle, or a restart. so the chat kept answering with the previous model.
 *
 * - Model: `session.setModel()` is Pi's own primitive. It validates that auth
 *   exists and records the change in the transcript, so a session that is later
 *   resumed from disk keeps it.
 * - Thinking level: `session.setThinkingLevel()` clamps to what the model
 *   supports and records the change. Saale's "default" means "no opinion", so
 *   there is nothing to apply.
 * - Tool config: tools are resolved from the config when the session is built,
 *   so the loadout cannot be changed in place. the session is dropped instead
 *   and rebuilt on the next message. Never while a run is in flight: eviction
 *   disposes the session and would abort it.
 *
 * Shared by the session PATCH route (the header's model/thinking/tool controls)
 * and the `/model` command, so both take effect immediately.
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

  if (modelChanged && updated.modelProvider && updated.modelName) {
    try {
      const { modelRuntime } = await buildModelRuntime(userId);
      const model = modelRuntime.getModel(updated.modelProvider, updated.modelName);
      if (model) {
        await pooled.session.setModel(model);
      } else {
        console.error(
          `Model ${updated.modelProvider}/${updated.modelName} is not available to user ${userId}`,
        );
      }
    } catch (err) {
      console.error("Failed to switch the running agent's model:", err);
    }
  }

  if (levelChanged && isPiThinkingLevel(updated.thinkingLevel)) {
    try {
      pooled.session.setThinkingLevel(updated.thinkingLevel);
    } catch (err) {
      console.error("Failed to switch the running agent's thinking level:", err);
    }
  }

  if (toolsChanged) {
    if (pooled.session.isStreaming || pooled.promptInFlight) {
      console.warn(
        `Tool config changed for a busy chat session ${sessionId}. the new loadout applies after the current run`,
      );
    } else {
      await remove(getPoolKey(userId, sessionId));
    }
  }
}
