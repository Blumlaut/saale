import type { Job } from "bullmq";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { syncEmailAccount } from "@/lib/email/sync";
import { moveMessage } from "@/lib/email/imap";
import { buildModelRegistry } from "@/lib/pi/models";
import { addJobRun, updateJobRun } from "@/lib/queue";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { syncCalendarAccount } from "@/lib/calendar/sync";
import { extractEventsFromEmails } from "@/lib/calendar/email-extraction";
import {
  resolveUserEmailAccountIds,
  resolveUserCalendarAccountIds,
} from "@/lib/queue/user-isolation";

// ─── AI Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatch a non-streaming AI task using the Pi agent.
 * Creates a one-shot session, sends a prompt, and waits for the response.
 *
 * @param userId - The user whose API keys and model registry to use
 * @param prompt - The prompt to send to the AI
 * @param systemPrompt - Optional system prompt (defaults to a task-oriented prompt)
 * @param modelId - Optional model override ("provider:modelName")
 * @returns The AI's text response
 */
export async function dispatchAiTask(
  userId: string,
  prompt: string,
  options?: {
    systemPrompt?: string;
    modelId?: string | null;
  },
): Promise<string> {
  const modelInfo = await resolveModelForPurpose(userId, "", options?.modelId);

  // Build a minimal model registry (no tools, no extensions — just the model)
  const { modelRegistry, authStorage } = await buildModelRegistry(userId);

  let model;
  if (modelInfo) {
    model = modelRegistry.find(modelInfo.provider, modelInfo.name);
  }

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: "all",
    ...(model ? { model } : {}),
    thinkingLevel: "off",
  });

  session.agent.state.systemPrompt =
    options?.systemPrompt ??
    `You are an AI assistant processing automated tasks. Respond with valid JSON only — no markdown, no explanation, just the raw JSON object.`;

  let timerId: ReturnType<typeof setTimeout>;

  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        clearTimeout(timerId);
        unsubscribe();
        const lastMsg = event.messages.findLast((m) => m.role === "assistant");
        const textBlocks = lastMsg?.content.filter(
          (c) => typeof c === "object" && c.type === "text",
        );
        const text =
          textBlocks
            ?.map((c) => (typeof c === "object" && "text" in c ? (c.text as string) : ""))
            .join("") ?? "";
        resolve(text);
      }
    });

    // Timeout after 5min
    timerId = setTimeout(() => {
      unsubscribe();
      reject(new Error("AI task timed out (5min)"));
    }, 5 * 60_000);

    // Call agent.prompt directly to bypass AgentSession's preflight logic
    // which resets systemPrompt back to the Pi base prompt on every turn
    session.agent.prompt(prompt);
  });
}

// ─── Job Processing ──────────────────────────────────────────────────────────

/**
 * Process a single job execution.
 * This is the handler called by BullMQ workers.
 */
export async function processJob(job: Job): Promise<void> {
  const { taskId, runId, type, modelId, ...config } = job.data;

  // Resolve the user for this task
  const task = await prisma.queueTask.findUnique({
    where: { id: taskId },
    select: { userId: true },
  });

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Create a run record for scheduled jobs (no runId), or use existing for manual runs
  const run = runId
    ? null
    : await addJobRun(taskId, "pending", JSON.stringify({ type, modelId, ...config }));

  const effectiveRunId = runId ?? run?.id;

  // Mark run as running
  if (effectiveRunId) {
    await updateJobRun(effectiveRunId, { status: "running", startedAt: new Date() });
  }

  try {
    let output: string;

    if (type === "email_sync") {
      const accountIds = await resolveUserEmailAccountIds(task.userId, config.accountId);

      if (config.accountId) {
        const result = await syncEmailAccount(config.accountId);
        output = JSON.stringify(result);
      } else {
        const results = await Promise.all(accountIds.map((id) => syncEmailAccount(id)));
        output = JSON.stringify({
          accounts: results.length,
          results,
        });
      }
    } else if (type === "summarization") {
      const accountIds = await resolveUserEmailAccountIds(task.userId, config.accountId);

      const whereClause: Record<string, unknown> = {
        accountId: { in: accountIds },
        ...(config.accountId ? { accountId: config.accountId } : {}),
        aiSummary: null,
      };
      if (config.maxEmailAge && config.maxEmailAge > 0) {
        whereClause.date = { gte: new Date(Date.now() - config.maxEmailAge * 60 * 60 * 1000) };
      }
      const emails = await prisma.emailMessage.findMany({
        where: whereClause,
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
          date: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, summaries: [] });
      } else {
        const prompt = JSON.stringify({
          task: "summarize",
          instructions:
            "For each email, write a concise 1-2 sentence summary capturing the key point or action needed. Return a JSON object with a 'summaries' array where each item has 'id' and 'summary'.",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { summaries: [] };
        }

        const summaries = (parsed.summaries ?? []).filter(
          (s: { id: string; summary: string }) => s.id && s.summary,
        );

        // Guard: only update emails from the scanned batch (defense against AI hallucination)
        const scannedIds = new Set(emails.map((e) => e.id));
        for (const summary of summaries) {
          if (!scannedIds.has(summary.id)) continue;
          await prisma.emailMessage.update({
            where: { id: summary.id },
            data: { aiSummary: summary.summary },
          });
        }

        output = JSON.stringify({
          processed: emails.length,
          summarized: summaries.length,
          summaries,
        });
      }
    } else if (type === "classification") {
      const accountIds = await resolveUserEmailAccountIds(task.userId, config.accountId);

      const whereClause: Record<string, unknown> = {
        accountId: { in: accountIds },
        ...(config.accountId ? { accountId: config.accountId } : {}),
        classified: false,
      };
      if (config.maxEmailAge && config.maxEmailAge > 0) {
        whereClause.date = { gte: new Date(Date.now() - config.maxEmailAge * 60 * 60 * 1000) };
      }
      const emails = await prisma.emailMessage.findMany({
        where: whereClause,
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
          tags: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, classifications: [] });
      } else {
        const prompt = JSON.stringify({
          task: "classify",
          instructions:
            "For each email, assign relevant category tags from this list: finance, schedule, newsletter, security, social, work, personal, shopping, travel, health, news, promotion, notification. Return a JSON object with a 'classifications' array where each item has 'id' and 'tags' (array of strings).",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { classifications: [] };
        }

        const classifications = (parsed.classifications ?? []).filter(
          (c: { id: string; tags: string[] }) => c.id && Array.isArray(c.tags),
        );

        // Guard: only update emails from the scanned batch (defense against AI hallucination)
        const scannedIds = new Set(emails.map((e) => e.id));
        for (const classification of classifications) {
          if (!scannedIds.has(classification.id)) continue;
          const newTags = Array.from(
            new Set([
              ...(emails.find((e) => e.id === classification.id)?.tags ?? []),
              ...classification.tags,
            ]),
          );
          await prisma.emailMessage.update({
            where: { id: classification.id },
            data: {
              tags: newTags,
              classified: true,
            },
          });
        }

        output = JSON.stringify({
          processed: emails.length,
          classified: classifications.length,
          classifications,
        });
      }
    } else if (type === "calendar_sync") {
      const accountIds = await resolveUserCalendarAccountIds(task.userId, config.accountId);

      if (config.accountId) {
        const result = await syncCalendarAccount(config.accountId);
        output = JSON.stringify(result);
      } else {
        const results = await Promise.all(accountIds.map((id) => syncCalendarAccount(id)));
        output = JSON.stringify({
          accounts: results.length,
          results,
        });
      }
    } else if (type === "email_to_calendar") {
      // Validate target calendar belongs to user (defense in depth)
      let effectiveTargetCalendarId: string | undefined;
      if (config.targetCalendarId) {
        const targetCal = await prisma.calendar.findFirst({
          where: { id: config.targetCalendarId, account: { userId: task.userId } },
        });
        if (!targetCal) {
          throw new Error(`Calendar ${config.targetCalendarId} not found`);
        }
        effectiveTargetCalendarId = config.targetCalendarId;
      }

      const result = await extractEventsFromEmails({
        userId: task.userId,
        accountId: config.accountId || undefined,
        ...(effectiveTargetCalendarId ? { targetCalendarId: effectiveTargetCalendarId } : {}),
        limit: config.limit ?? 20,
        maxEmailAge: config.maxEmailAge ?? 48,
        modelId,
      });
      output = JSON.stringify(result);
    } else if (type === "subscription_sync") {
      const { syncAllSubscriptions } = await import("@/lib/calendar/subscription-sync");
      const result = await syncAllSubscriptions(task.userId);
      output = JSON.stringify(result);
    } else if (type === "spam_filtering") {
      const accountIds = await resolveUserEmailAccountIds(task.userId, config.accountId);

      const whereClause: Record<string, unknown> = {
        accountId: { in: accountIds },
        ...(config.accountId ? { accountId: config.accountId } : {}),
        folder: "INBOX",
        spamScore: null,
      };
      if (config.maxEmailAge && config.maxEmailAge > 0) {
        whereClause.date = { gte: new Date(Date.now() - config.maxEmailAge * 60 * 60 * 1000) };
      }
      const emails = await prisma.emailMessage.findMany({
        where: whereClause,
        orderBy: { date: "desc" },
        take: config.limit ?? 20,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, results: [] });
      } else {
        const prompt = JSON.stringify({
          task: "spam_analysis",
          instructions:
            "For each email, evaluate whether it is likely spam. Return a JSON object with a 'results' array where each item has 'id', 'spamScore' (0-1 float, higher = more likely spam), and 'reason' (brief explanation).",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { results: [] };
        }

        const spamResults = (parsed.results ?? []).filter(
          (r: { id: string; spamScore: number }) => r.id && typeof r.spamScore === "number",
        );

        // Guard: only update emails from the scanned batch (defense against AI hallucination)
        const scannedIds = new Set(emails.map((e) => e.id));
        for (const result of spamResults) {
          if (!scannedIds.has(result.id)) continue;
          const shouldMove = result.spamScore > (config.spamThreshold ?? 0.85);
          const updated = await prisma.emailMessage.update({
            where: { id: result.id },
            data: {
              spamScore: Math.min(Math.max(result.spamScore, 0), 1),
              ...(shouldMove ? { folder: "Spam" } : {}),
            },
            select: {
              accountId: true,
              uid: true,
              folder: true,
            },
          });

          // Sync move to IMAP server (best-effort, fire-and-forget)
          if (shouldMove && updated.folder !== "Spam") {
            moveMessage(updated.accountId, updated.folder, updated.uid, "Spam").catch(() => {
              // Already logged inside moveMessage
            });
          }
        }

        output = JSON.stringify({
          processed: emails.length,
          analyzed: spamResults.length,
          movedToSpam: spamResults.filter(
            (r: { spamScore: number }) => r.spamScore > (config.spamThreshold ?? 0.85),
          ).length,
          results: spamResults,
        });
      }
    } else if (type === "memory_extraction") {
      const maxSessions = config.maxSessionsPerRun ?? 10;
      const maxExisting = config.maxExistingMemories ?? 15;

      // Find sessions with unprocessed messages
      // Use raw query to handle NULL-safe comparison: lastSummarizedAt IS NULL OR lastSummarizedAt < updatedAt
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
          WHERE "userId" = ${task.userId}
            AND "messageCount" > 0
            AND ("lastSummarizedAt" IS NULL OR "lastSummarizedAt" < "updatedAt")
          ORDER BY "updatedAt" DESC
          LIMIT ${maxSessions}
        `,
      );

      let totalAdded = 0;
      let totalRemoved = 0;
      let sessionsProcessed = 0;

      for (const session of sessions) {
        // Fetch new messages since last summarized
        const newMessages = await prisma.chatMessage.findMany({
          where: {
            sessionId: session.id,
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
          // No new messages — advance cursor anyway
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
          // Keep newest messages, discard oldest
          const truncated = newMessages.slice(-Math.floor(newMessages.length / 2));
          messagesText = truncated.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
        }

        // Fetch existing categories
        const categoryResults = await prisma.memory.findMany({
          where: { userId: task.userId },
          select: { collection: true },
          distinct: ["collection"],
        });
        const existingCategories = categoryResults.map((r) => r.collection);

        // Fetch top existing memories for dedup context
        const existingMemories = await prisma.memory.findMany({
          where: { userId: task.userId },
          orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
          take: maxExisting,
          select: {
            id: true,
            collection: true,
            title: true,
            content: true,
            tags: true,
            importance: true,
          },
        });

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

Existing memories (for deduplication — do not re-extract these):
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
- Task/job configurations or scheduling details
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
- Set importance 1-10: explicit user statements = 7-10, inferred = 3-5

Output JSON:
{
  "add": [
    { "collection": "facts", "title": "...", "content": "...", "tags": ["..."], "importance": 7 }
  ],
  "remove": ["memory_id_1"],
  "summary": "updated running summary of the full conversation so far"
}
`.trim();

        const response = await dispatchAiTask(task.userId, extractionPrompt, {
          systemPrompt:
            "You are a selective memory extraction engine. Most conversations have nothing worth remembering. Extract only concrete, long-term user facts and preferences. Output valid JSON only.",
          modelId,
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
          let bestMatch = null;

          for (const existing of existingInCollection) {
            const overlap = titleWordOverlap(candidate.title, existing.title);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestMatch = existing;
            }
          }

          if (bestOverlap > 0.5 && bestMatch) {
            // Duplicate — skip
            continue;
          } else if (bestOverlap >= 0.25 && bestMatch) {
            // Similar — merge content into existing
            await prisma.memory.update({
              where: { id: bestMatch.id },
              data: {
                content: bestMatch.content + "\n\n" + candidate.content,
                tags: Array.from(new Set([...bestMatch.tags, ...(candidate.tags ?? [])])),
                importance: Math.max(bestMatch.importance, candidate.importance ?? 5),
              },
            });
            totalAdded++;
          } else {
            // New memory
            await prisma.memory.create({
              data: {
                userId: task.userId,
                collection: candidate.collection,
                title: candidate.title,
                content: candidate.content,
                tags: candidate.tags ?? [],
                importance: candidate.importance ?? 5,
                source: session.id,
              },
            });
            totalAdded++;
          }
        }

        // Handle removals
        if (removals.length > 0) {
          // Guard: only delete memories that belong to this user
          const deletable = await prisma.memory.deleteMany({
            where: {
              id: { in: removals },
              userId: task.userId,
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

      output = JSON.stringify({
        sessionsProcessed,
        memoriesAdded: totalAdded,
        memoriesRemoved: totalRemoved,
      });
    } else if (type === "memory_pruning") {
      const unusedDays = config.unusedDays ?? 90;
      const lowImportanceDays = config.lowImportanceDays ?? 180;

      const unusedCutoff = new Date(Date.now() - unusedDays * 24 * 60 * 60 * 1000);
      const lowImportanceCutoff = new Date(Date.now() - lowImportanceDays * 24 * 60 * 60 * 1000);

      // Delete unused memories (0 accesses, older than threshold)
      const unusedDeleted = await prisma.memory.deleteMany({
        where: {
          userId: task.userId,
          accessCount: 0,
          createdAt: { lt: unusedCutoff },
        },
      });

      // Delete low-importance memories (importance < 3, older than threshold)
      const lowImportanceDeleted = await prisma.memory.deleteMany({
        where: {
          userId: task.userId,
          importance: { lt: 3 },
          createdAt: { lt: lowImportanceCutoff },
        },
      });

      // Reset access counts for next cycle
      await prisma.memory.updateMany({
        where: { userId: task.userId },
        data: { accessCount: 0 },
      });

      output = JSON.stringify({
        unusedDeleted: unusedDeleted.count,
        lowImportanceDeleted: lowImportanceDeleted.count,
        totalDeleted: unusedDeleted.count + lowImportanceDeleted.count,
      });
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }

    // Mark as completed
    if (effectiveRunId) {
      await updateJobRun(effectiveRunId, { status: "completed", output, completedAt: new Date() });
    }

    // Update task metadata
    await prisma.queueTask.update({
      where: { id: taskId },
      data: {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
      },
    });
  } catch (err) {
    const errorMessage = (err as Error).message;

    if (effectiveRunId) {
      await updateJobRun(effectiveRunId, {
        status: "error",
        error: errorMessage,
        completedAt: new Date(),
      });
    }

    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Compute word overlap ratio between two titles.
 * Returns a value between 0 (no overlap) and 1 (identical words).
 */
function titleWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) matches++;
  }

  // Overlap relative to the smaller set
  const minSize = Math.min(wordsA.size, wordsB.size);
  return matches / minSize;
}
