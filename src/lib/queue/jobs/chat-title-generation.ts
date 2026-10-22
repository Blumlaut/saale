import { prisma } from "@/lib/db";
import { dispatchAiJob } from "@/lib/queue/job-handler";

export const metadata = {
  type: "chat_title_generation",
  label: "Chat Title Generation",
  description: "Generate better titles for chats still using default or auto-generated titles",
  icon: "MessageSquarePlus",
  defaultCron: "0 */4 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "maxSessionsPerRun",
    label: "Max sessions per run",
    description: "Number of sessions to process per execution",
    type: "number" as const,
    default: 10,
    min: 1,
    max: 50,
  },
  {
    key: "modelId",
    label: "AI Model",
    description: "Override the default model for this job",
    type: "model" as const,
    default: "",
  },
];

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { config, userId, modelId } = params;
  const maxSessions = (config.maxSessionsPerRun as number) ?? 10;

  // Find sessions with default or auto-generated titles
  const sessions = await prisma.chatSession.findMany({
    where: {
      userId,
      messageCount: { gt: 1 }, // skip sessions with 0-1 messages
      OR: [{ title: { endsWith: "..." } }, { title: "New Chat" }],
    },
    orderBy: { lastActivityAt: "desc" },
    take: maxSessions,
    select: {
      id: true,
      title: true,
      messageCount: true,
    },
  });

  let titlesGenerated = 0;
  let sessionsSkipped = 0;

  // Fetch messages for all sessions in one query
  const sessionIds = sessions.map((s) => s.id);
  const allMessages = await prisma.chatMessage.findMany({
    where: { sessionId: { in: sessionIds }, queuedAt: null },
    orderBy: { createdAt: "asc" },
    select: { sessionId: true, role: true, content: true },
  });
  const messagesBySession = new Map<string, Array<{ role: string; content: string }>>();
  for (const m of allMessages) {
    const list = messagesBySession.get(m.sessionId) ?? [];
    if (list.length < 20) list.push({ role: m.role, content: m.content });
    messagesBySession.set(m.sessionId, list);
  }

  for (const session of sessions) {
    // Skip if title was already manually updated (no longer matches default patterns)
    if (session.title !== "New Chat" && !session.title.endsWith("...")) {
      sessionsSkipped++;
      continue;
    }

    const messages = messagesBySession.get(session.id) ?? [];

    if (messages.length === 0) {
      sessionsSkipped++;
      continue;
    }

    // Truncate messages to ~5k tokens (rough: 4 chars per token)
    const maxChars = 5_000 * 4;
    let conversationText = messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    if (conversationText.length > maxChars) {
      const truncated = messages.slice(-Math.floor(messages.length / 2));
      conversationText = truncated.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    }

    const titlePrompt = `
You are a chat title generator. Read this conversation and produce a concise, descriptive title.

Conversation:
${conversationText}

Rules:
- Maximum 50 characters
- Capture the main topic or purpose of the conversation
- Use sentence case (not ALL CAPS)
- Be specific, not generic (avoid "Help", "Question", "Chat")
- If it's code-related, mention the tech or framework
- If it's about a task, mention what the task is

Output JSON only:
{ "title": "..." }
`.trim();

    const response = await dispatchAiJob(userId, titlePrompt, {
      systemPrompt:
        "You are a chat title generator. Produce concise, descriptive titles for conversations. Output valid JSON only.",
      ...(modelId ? { modelId } : {}),
    });

    let newTitle: string | null = null;
    try {
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed.title && typeof parsed.title === "string") {
        newTitle = parsed.title.replace(/\0/g, "").slice(0, 50).trim();
      }
    } catch {
      // Parse failed. skip
    }

    if (newTitle && newTitle !== session.title) {
      await prisma.chatSession.update({
        where: { id: session.id, userId },
        data: { title: newTitle },
      });
      titlesGenerated++;
    } else {
      sessionsSkipped++;
    }
  }

  return JSON.stringify({
    sessionsScanned: sessions.length,
    titlesGenerated,
    sessionsSkipped,
  });
}
