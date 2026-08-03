/**
 * Pure decision logic for the chat SSE stream endpoint.
 *
 * Extracted from the route handler for testability — the route imports and
 * calls these functions with runtime values (DB messages, pool state, Redis
 * signals, etc.).
 */

/** Shape of a chat message from the DB (minimal fields needed for decisions). */
export interface DbMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "custom";
  content?: string;
}

/** What a new SSE connection should do. */
export type StreamAction =
  | { type: "prompt"; reason: string }
  | { type: "observe"; reason: string }
  | { type: "done"; reason: string };

/**
 * Decide what a new SSE connection should do.
 *
 * Signals:
 * - `lastMessage` — latest DB message (or undefined for an empty chat)
 * - `hasAssistantAfterLastUser` — an assistant message was saved after the
 *   last user message (the response already exists)
 * - `isGenerating` — a generation is registered in Redis (any process)
 * - `generationStartedAt` — epoch ms when the current generation started
 * - `poolLastPromptedMessageId` — the message this process already prompted
 *   (in-process in-flight guard)
 * - `pendingPromptMessageId` — the message the POST /messages route wants the
 *   SSE connection to prompt (the "claim")
 * - `bufferHasDone` / `bufferHasEvents` — state of the Redis event buffer
 *
 * A generation is considered "stale" when it has been registered for longer
 * than the grace period without producing a single buffered event — e.g. the
 * client died right after POST /messages, or a worker crashed mid-run. In
 * that case we take over and prompt, so sessions don't hang forever.
 */
export function decideStreamAction(params: {
  lastMessage: DbMessage | undefined;
  hasAssistantAfterLastUser: boolean;
  isGenerating: boolean;
  generationStartedAt: number | null;
  poolLastPromptedMessageId: string | null;
  pendingPromptMessageId: string | null;
  bufferHasDone: boolean;
  bufferHasEvents: boolean;
  staleGraceMs?: number;
}): StreamAction {
  const grace = params.staleGraceMs ?? 90_000;
  const generationActive =
    params.isGenerating &&
    !(
      params.generationStartedAt != null &&
      Date.now() - params.generationStartedAt > grace &&
      !params.bufferHasEvents
    );

  const last = params.lastMessage;

  if (last && last.role === "user") {
    // Already prompting this exact message in this process — just observe.
    if (params.poolLastPromptedMessageId === last.id) {
      return { type: "observe", reason: "already prompted in this process" };
    }
    // The POST route claimed this message — we are the expected prompter.
    if (params.pendingPromptMessageId === last.id) {
      return { type: "prompt", reason: "prompt claimed by message POST" };
    }
    // Some process is actively generating (worker or another connection).
    if (generationActive) {
      return { type: "observe", reason: "generation in progress" };
    }
    // The response already exists — nothing to stream.
    if (params.hasAssistantAfterLastUser) {
      return { type: "done", reason: "last user message already answered" };
    }
    // A finished run's events are buffered — replay delivers `done`.
    if (params.bufferHasDone) {
      return { type: "observe", reason: "done event already buffered" };
    }
    // Unanswered user message and nothing running: we own the prompt
    // (covers recovery from a crashed POST, and stale generations).
    return { type: "prompt", reason: "unanswered user message" };
  }

  // Last message is not a user message (assistant, compaction, or empty).
  // A multi-turn run can be mid-generation with an assistant message saved.
  if (generationActive) {
    return { type: "observe", reason: "generation in progress" };
  }
  return { type: "done", reason: "idle conversation" };
}

/**
 * Escape literal newlines in a JSON payload to prevent premature SSE event
 * termination. SSE spec: a line containing only "\n" terminates the event block.
 *
 * @param data - The value to serialize and escape.
 */
export function formatSseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `event: ${event}\ndata: ${escaped}\n\n`;
}

/**
 * Accumulate text from assistant message_update events.
 *
 * Pi agent emits cumulative text (the full text so far, not deltas).
 * This extracts the cumulative text from a message's content array.
 *
 * @param content - The content array from a message_update event.
 */
export function extractCumulativeText(content: unknown[]): string {
  return content
    .filter(
      (c): c is { type: string; text?: string } =>
        typeof c === "object" && c !== null && "type" in c && c.type === "text",
    )
    .map((c) => c.text || "")
    .join("");
}

/**
 * Extract thinking content from a message_update event.
 *
 * @param content - The content array from a message_update event.
 */
export function extractThinking(content: unknown[]): string | null {
  const block = content.find(
    (c): c is { type: string; thinking?: string } =>
      typeof c === "object" && c !== null && "type" in c && c.type === "thinking",
  );
  if (!block || !block.thinking) return null;
  return block.thinking;
}

/**
 * Collect tool call IDs from a message's content array.
 *
 * @param content - The content array from a message_update event.
 */
export function extractToolCallIds(content: unknown[]): string[] {
  return content
    .filter(
      (c): c is { type: string; id?: string } =>
        typeof c === "object" && c !== null && "type" in c && c.type === "toolCall",
    )
    .map((c) => c.id as string);
}

/**
 * Build the final assistant message data from agent_end event content.
 *
 * @param content - The content array from the final assistant message.
 * @param toolCallResults - Map of tool call results (from tool_execution_end events).
 */
export function buildFinalAssistantMessage(
  content: unknown[],
  toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  >,
): {
  text: string;
  thinking: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }>;
} {
  const text = extractCumulativeText(content);
  const thinking = extractThinking(content);

  const toolCalls = content
    .filter(
      (c): c is { id: string; name: string; arguments: Record<string, unknown> } =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        c.type === "toolCall" &&
        "id" in c &&
        "name" in c,
    )
    .map((tc) => {
      const result = toolCallResults.get(tc.id);
      return {
        id: tc.id,
        name: tc.name,
        args: tc.arguments,
        result: result?.result,
        isError: result?.isError,
      };
    });

  return { text, thinking, toolCalls };
}
