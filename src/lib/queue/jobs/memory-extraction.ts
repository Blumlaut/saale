import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { dispatchAiJob } from "@/lib/queue/job-handler";
import { titleWordOverlap } from "./_helpers";

export const metadata = {
  type: "memory_extraction",
  label: "Memory Extraction",
  description: "Extract facts, decisions, and patterns from chat history",
  icon: "Brain",
  defaultCron: "0 */6 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "maxSessionsPerRun",
    label: "Max sessions per run",
    description: "Batch size. sessions processed per execution",
    type: "number" as const,
    default: 10,
    min: 1,
    max: 50,
  },
  {
    key: "maxExistingMemories",
    label: "Context memories",
    description:
      "Existing memories included for deduplication (higher = more accurate, more tokens)",
    type: "number" as const,
    default: 15,
    min: 5,
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
  const maxExisting = (config.maxExistingMemories as number) ?? 15;

  // Find sessions with unprocessed messages.
  // Cursor: lastSummarizedAt vs lastActivityAt (real message activity). NOT
  // updatedAt. the job itself writes to the session row (cursor/summary),
  // which bumps @updatedAt and would re-select the same sessions forever,
  // keeping their "last activity" perpetually fresh.
  const sessions = await prisma.$queryRaw<
    Array<{
      id: string;
      lastSummarizedAt: Date | null;
      memorySummary: string | null;
    }>
  >(
    Prisma.sql`
      SELECT id, "lastSummarizedAt", "memorySummary"
      FROM "ChatSession"
      WHERE "userId" = ${userId}
        AND "messageCount" > 0
        AND ("lastSummarizedAt" IS NULL OR "lastSummarizedAt" < "lastActivityAt")
      ORDER BY "lastActivityAt" DESC
      LIMIT ${maxSessions}
    `,
  );

  let totalAdded = 0;
  let totalRemoved = 0;
  let sessionsProcessed = 0;

  // Fetch existing categories and recent memories once (same for every session)
  const categoryResults = await prisma.memory.findMany({
    where: { userId },
    select: { collection: true },
    distinct: ["collection"],
  });
  const existingCategories = categoryResults.map((r) => r.collection);

  const existingMemories = await prisma.memory.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: maxExisting,
    select: {
      id: true,
      collection: true,
      title: true,
      content: true,
      tags: true,
    },
  });

  for (const session of sessions) {
    // Fetch new messages since last summarized (queued messages are not part
    // of the conversation yet)
    const newMessages = await prisma.chatMessage.findMany({
      where: {
        sessionId: session.id,
        queuedAt: null,
        ...(session.lastSummarizedAt ? { createdAt: { gt: session.lastSummarizedAt } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        content: true,
        createdAt: true,
      },
    });

    if (newMessages.length === 0) {
      // No new messages. advance cursor anyway
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { lastSummarizedAt: new Date() },
      });
      sessionsProcessed++;
      continue;
    }

    // Truncate if messages exceed ~15k tokens (rough estimate: 4 chars per token)
    const maxChars = 15_000 * 4;
    let messagesText = newMessages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    if (messagesText.length > maxChars) {
      const truncated = newMessages.slice(-Math.floor(newMessages.length / 2));
      messagesText = truncated.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    }

    // Build extraction prompt
    const extractionPrompt = `
You are a memory extraction engine. Scan this conversation for information worth remembering long-term.

${
  session.memorySummary
    ? `Previous conversation summary:
"${session.memorySummary}"`
    : "No previous summary."
}

New messages:
${messagesText}

Existing memory categories:
${existingCategories.length > 0 ? existingCategories.join(", ") : "(none yet)"}

Existing memories (for deduplication. do not re-extract these):
${
  existingMemories.length > 0
    ? existingMemories
        .map((m) => `- [${m.collection}] ${m.title}: ${m.content.slice(0, 200)}`)
        .join("\n")
    : "(none)"
}

Most conversations will have ZERO extractable memories. Default to an empty "add" array.

What to extract (only if explicitly stated by the user):
- Personal facts: name, location, job, relationships, health
- Preferences: favorite tools, tastes, working style, dislikes
- Goals and plans with specific details
- Projects with concrete scope or status
- Decisions that shape future work (architecture choices, tech stack picks)

What to NEVER extract:
- Errors, bugs, or troubleshooting steps (these are transient)
- Job configurations or scheduling details
- "Keep this enabled" / "try again" / workflow instructions
- Technical how-to instructions the assistant provided
- Observations about the conversation itself
- Small talk, greetings, or pleasantries
- Anything already captured in existing memories

Categorization:
- Place each memory into one of the existing categories above
- Only create a new category if none of the existing ones fit
- Category names should be lowercase, single words (e.g. "facts", "decisions", "projects")

Rules:
- If you're unsure whether something is worth remembering, skip it
- Only extract when the user explicitly states something about themselves or their work

Output JSON:
{
  "add": [
    { "collection": "facts", "title": "...", "content": "...", "tags": ["..."] }
  ],
  "remove": ["memory_id_1"],
  "summary": "updated running summary of the full conversation so far"
}
`.trim();

    const response = await dispatchAiJob(userId, extractionPrompt, {
      systemPrompt:
        "You are a selective memory extraction engine. Most conversations have nothing worth remembering. Extract only concrete, long-term user facts and preferences. Output valid JSON only.",
      ...(modelId ? { modelId } : {}),
    });

    let parsed;
    try {
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      parsed = { add: [], remove: [], summary: session.memorySummary ?? "" };
    }

    const candidates = (parsed.add ?? []).filter(
      (m: { collection: string; title: string; content: string }) =>
        m.collection && m.title && m.content,
    );
    const removals = (parsed.remove ?? []).filter((id: string) => typeof id === "string");
    const newSummary =
      typeof parsed.summary === "string" ? parsed.summary : (session.memorySummary ?? "");

    // Code-level deduplication against existing memories
    const existingByCollection = new Map<string, typeof existingMemories>();
    for (const mem of existingMemories) {
      const list = existingByCollection.get(mem.collection) ?? [];
      list.push(mem);
      existingByCollection.set(mem.collection, list);
    }

    for (const candidate of candidates) {
      const existingInCollection = existingByCollection.get(candidate.collection) ?? [];
      let bestOverlap = 0;
      let bestMatch: (typeof existingMemories)[number] | null = null;

      for (const existing of existingInCollection) {
        const overlap = titleWordOverlap(candidate.title, existing.title);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = existing;
        }
      }

      if (bestOverlap > 0.5 && bestMatch) {
        // Duplicate. skip
        continue;
      } else if (bestOverlap >= 0.25 && bestMatch) {
        // Similar. merge content into existing
        await prisma.memory.update({
          where: { id: bestMatch.id },
          data: {
            content: bestMatch.content + "\n\n" + candidate.content,
            tags: Array.from(new Set([...bestMatch.tags, ...(candidate.tags ?? [])])),
          },
        });
        totalAdded++;
      } else {
        // New memory
        await prisma.memory.create({
          data: {
            userId,
            collection: candidate.collection,
            title: candidate.title,
            content: candidate.content,
            tags: candidate.tags ?? [],
            source: session.id,
          },
        });
        totalAdded++;
      }
    }

    // Handle removals
    if (removals.length > 0) {
      const deletable = await prisma.memory.deleteMany({
        where: {
          id: { in: removals },
          userId,
        },
      });
      totalRemoved += deletable.count;
    }

    // Update session cursor and summary
    await prisma.chatSession.update({
      where: { id: session.id },
      data: {
        lastSummarizedAt: new Date(),
        memorySummary: newSummary,
      },
    });
    sessionsProcessed++;
  }

  return JSON.stringify({
    sessionsProcessed,
    memoriesAdded: totalAdded,
    memoriesRemoved: totalRemoved,
  });
}
