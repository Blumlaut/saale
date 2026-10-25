/**
 * The variables a command can read about the agent running it.
 *
 * Read from the live pooled session when a command starts, never captured when
 * the session was built: the header's model control and `/model` change the
 * model mid-session, and a snapshot would keep naming the previous one.
 */

import { get as getPooledSession, getPoolKey } from "./agent-pool";

/** The variables for one command in `sessionId`'s workspace. */
export function sessionEnvVars(userId: string, sessionId: string): Record<string, string> {
  const session = getPooledSession(getPoolKey(userId, sessionId))?.session;
  const model = session?.model;

  const env: Record<string, string> = { SAALE_CHAT_ID: sessionId };
  if (model) {
    env.SAALE_MODEL = model.id;
    env.SAALE_MODEL_PROVIDER = model.provider;
  }
  if (session) env.SAALE_THINKING_LEVEL = session.thinkingLevel;
  return env;
}
