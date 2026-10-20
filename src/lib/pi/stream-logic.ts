/**
 * Pure decision logic for the chat SSE stream endpoint.
 *
 * Extracted from the route handler for testability. the route imports and
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
 * - `lastMessage`. latest DB message (or undefined for an empty chat)
 * - `hasAssistantAfterLastUser`. an assistant message was saved after the
 *   last user message (the response already exists)
 * - `isGenerating`. a generation is registered AND its liveness heartbeat is
 *   fresh in Redis (any process). A crashed process's flag expires within
 *   seconds, so this means a generation is genuinely running somewhere.
 * - `poolLastPromptedMessageId`. the message this process already prompted
 *   (in-process in-flight guard)
 * - `pendingPromptMessageId`. the message the POST /messages route wants the
 *   SSE connection to prompt (the "claim")
 * - `bufferHasDone`. the buffer holds a finished run's terminal event
 * - `queueHeld`. the user pressed Stop on this session and has not sent
 *   anything since (see redis.ts). Stop means "nothing more until I say so",
 *   so an unanswered message must not be re-prompted by a reconnect. that
 *   would silently restart the run the user just cancelled.
 */
export function decideStreamAction(params: {
  lastMessage: DbMessage | undefined;
  hasAssistantAfterLastUser: boolean;
  isGenerating: boolean;
  poolLastPromptedMessageId: string | null;
  pendingPromptMessageId: string | null;
  bufferHasDone: boolean;
  queueHeld: boolean;
}): StreamAction {
  const generationActive = params.isGenerating;

  const last = params.lastMessage;

  if (last && last.role === "user") {
    // The user stopped this session: nothing more until they send again. A
    // stopped run whose message is still unanswered must not be prompted
    // again. neither by a reconnect nor by a page load.
    if (params.queueHeld) {
      return { type: "done", reason: "session stopped by user" };
    }
    // Already prompting this exact message in this process. just observe.
    if (params.poolLastPromptedMessageId === last.id) {
      return { type: "observe", reason: "already prompted in this process" };
    }
    // The POST route claimed this message. we are the expected prompter.
    if (params.pendingPromptMessageId === last.id) {
      return { type: "prompt", reason: "prompt claimed by message POST" };
    }
    // Some process is actively generating (worker or another connection).
    if (generationActive) {
      return { type: "observe", reason: "generation in progress" };
    }
    // The response already exists. nothing to stream.
    if (params.hasAssistantAfterLastUser) {
      return { type: "done", reason: "last user message already answered" };
    }
    // A finished run's events are buffered. replay delivers `done`.
    if (params.bufferHasDone) {
      return { type: "observe", reason: "done event already buffered" };
    }
    // Unanswered user message and nothing running: we own the prompt. This
    // covers recovery. a message whose run never started (the client died
    // right after POST /messages) and one whose run died mid-flight, which
    // liveness now reports as inactive within seconds.
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
 * What a connection watching someone else's generation should do next.
 *
 * - `recover`. the generation is gone (its liveness heartbeat expired and no
 *   process is running it): settle the clients and reconnect so the session is
 *   re-decided and the unanswered message is resumed.
 * - `stop`. the run finished on its own; its clients already settled, so
 *   there is nothing left to watch.
 * - `keep-watching`. it is still running (here or elsewhere).
 */
export type StaleGenerationAction = "recover" | "stop" | "keep-watching";

/**
 * Decide what to do about the generation this connection is observing.
 *
 * A connection that observed a generation it does not own (another tab, the
 * Telegram worker) has no other way to learn that the owning process died
 * mid-run: the buffered events replay as if it were still going, and the
 * server's own heartbeat keeps the transport quietly alive. The stream route
 * polls this and acts on the answer.
 *
 * Two guards keep the recovery from misfiring:
 * - a terminal buffered event means the run finished on its own, and
 * - `localRunInFlight` means this process is the one running it, so a missed
 *   heartbeat must never let a watcher declare it dead.
 */
export function decideStaleGenerationAction(params: {
  /** Whether the generation's liveness heartbeat is still fresh in Redis. */
  isActiveElsewhere: boolean;
  /** Whether this process has a run of its own in flight. */
  localRunInFlight: boolean;
  /** Whether the newest buffered stream event ended a run (done/error). */
  bufferTailIsTerminal: boolean;
}): StaleGenerationAction {
  if (params.bufferTailIsTerminal) return "stop";
  if (params.localRunInFlight || params.isActiveElsewhere) return "keep-watching";
  return "recover";
}

/**
 * Escape literal newlines in a JSON payload to prevent premature SSE event
 * termination. SSE spec: a line containing only "\n" terminates the event block.
 *
 * `id` is optional. unbuffered terminal events (e.g. an idle "done" or the
 * heartbeat ping) omit it so they don't disturb the client's Last-Event-ID.
 *
 * @param data - The value to serialize and escape.
 */
export function formatSseEvent(event: string, data: unknown, id?: number): string {
  const json = JSON.stringify(data);
  const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${escaped}\n\n`;
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
