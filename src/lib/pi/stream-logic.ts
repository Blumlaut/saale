/**
 * Pure decision logic for the chat SSE stream endpoint.
 *
 * Extracted from the route handler for testability — the route imports and
 * calls these functions with runtime values (DB messages, pool state, etc.).
 */

/** Shape of a chat message from the DB (minimal fields needed for decisions). */
export interface DbMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "custom";
  content?: string;
}

/** Result of evaluating whether a new prompt should be sent. */
export interface PromptGuardResult {
  /** True if the last user message has not been processed yet. */
  shouldPrompt: boolean;
  /** Reason for the decision (for logging). */
  reason: string;
}

/** Result of evaluating a reconnect scenario. */
export type ReconnectAction =
  | { type: "emit-done"; reason: "agent-finished" }
  | { type: "wait-events"; reason: "agent-streaming" }
  | { type: "wait-events"; reason: "no-previous-prompt" };

/**
 * Evaluate whether a new prompt should be sent to the agent.
 *
 * Prevents double-prompting when multiple SSE connections race (e.g. page
 * reload during processing) or when a reconnect hits the primary stream path.
 *
 * @param lastMessage - The latest message from the DB (or undefined if empty chat).
 * @param lastPromptedMessageId - The DB message ID the agent last processed (null if none).
 */
export function evaluatePromptGuard(
  lastMessage: DbMessage | undefined,
  lastPromptedMessageId: string | null,
): PromptGuardResult {
  if (!lastMessage || lastMessage.role !== "user") {
    return { shouldPrompt: false, reason: "no user message" };
  }
  if (lastPromptedMessageId === lastMessage.id) {
    return { shouldPrompt: false, reason: "already prompted" };
  }
  return { shouldPrompt: true, reason: "new user message" };
}

/**
 * Evaluate what to do when a new SSE connection arrives but the message was
 * already processed (shouldPrompt=false, lastPromptedMessageId is set).
 *
 * @param isStreaming - Whether the agent is currently streaming a response.
 * @param lastPromptedMessageId - The DB message ID the agent last processed.
 */
export function evaluateReconnectAction(
  isStreaming: boolean,
  lastPromptedMessageId: string | null,
): ReconnectAction {
  if (!lastPromptedMessageId) {
    return { type: "wait-events", reason: "no-previous-prompt" };
  }
  if (!isStreaming) {
    return { type: "emit-done", reason: "agent-finished" };
  }
  return { type: "wait-events", reason: "agent-streaming" };
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
