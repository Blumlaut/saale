import { prisma } from "@/lib/db";
import { syncPooledAgentSession } from "@/lib/pi/sync-pooled-session";

/**
 * Switch a chat session's model and apply it to the live agent immediately.
 *
 * Shared by the session PATCH route and the `/model` command so both paths
 * change the model the same way. including pushing it into the pooled agent
 * session, which is otherwise only rebuilt after eviction.
 */
export async function setChatSessionModel(params: {
  userId: string;
  sessionId: string;
  provider: string;
  name: string;
}): Promise<void> {
  const { userId, sessionId, provider, name } = params;

  // User isolation: never trust the id alone.
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) throw new Error("Chat session not found");

  if (session.modelProvider === provider && session.modelName === name) return;

  const updated = await prisma.chatSession.update({
    where: { id: session.id },
    data: {
      modelProvider: provider,
      modelName: name,
      // A user-initiated change is real activity. keep the session list honest.
      lastActivityAt: new Date(),
    },
  });

  await syncPooledAgentSession({ userId, sessionId, previous: session, updated });
}
