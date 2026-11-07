/**
 * The variables a command can read about the agent running it.
 *
 * Read from the live pooled session when a command starts, never captured when
 * the session was built: the header's model control and `/model` change the
 * model mid-session, and a snapshot would keep naming the previous one.
 */

import { get as getPooledSession, getPoolKey } from "./agent-pool";

/** What the variables hold, once the chat's model and thinking level are known. */
export function sessionEnvValues(parts: {
  sessionId: string;
  modelId?: string | null | undefined;
  modelProvider?: string | null | undefined;
  thinkingLevel?: string | null | undefined;
}): Record<string, string> {
  const env: Record<string, string> = { SAALE_CHAT_ID: parts.sessionId };
  if (parts.modelId && parts.modelProvider) {
    env.SAALE_MODEL = parts.modelId;
    env.SAALE_MODEL_PROVIDER = parts.modelProvider;
  }
  if (parts.thinkingLevel) env.SAALE_THINKING_LEVEL = parts.thinkingLevel;
  return env;
}

/** The variables for one command in `sessionId`'s workspace. */
export function sessionEnvVars(userId: string, sessionId: string): Record<string, string> {
  const session = getPooledSession(getPoolKey(userId, sessionId))?.session;
  return sessionEnvValues({
    sessionId,
    modelId: session?.model?.id,
    modelProvider: session?.model?.provider,
    thinkingLevel: session?.thinkingLevel,
  });
}
