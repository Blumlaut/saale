import { prisma } from "@/lib/db";
import { dispatchAiTask } from "@/lib/queue/job-handler";

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
    description: "Override the default model for this task",
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
    orderBy: { updatedAt: "desc" },
    take: maxSessions,
    select: {
      id: true,
      title: true,
      messageCount: true,
    },
  });

  let titlesGenerated = 0;
  let sessionsSkipped = 0;

  for (const session of sessions) {
    // Skip if title was already manually updated (no longer matches default patterns)
    if (session.title !== "New Chat" && !session.title.endsWith("...")) {
      sessionsSkipped++;
      continue;
    }

    // Fetch conversation messages for context
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
      take: 20, // limit to first 20 messages for token efficiency
    });

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

    const response = await dispatchAiTask(userId, titlePrompt, {
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
      // Parse failed — skip
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
