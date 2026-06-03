/**
 * Pure functions for reconstructing conversation history from stored DB messages.
 *
 * These functions ensure that replayed messages are byte-identical to what the
 * live agent produced, which is critical for LLM provider cache hits.
 *
 * @see {@link https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching}
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A tool result as returned by a Pi custom tool execute() function. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: Record<string, unknown>;
}

/** A tool call stored in the DB (JSON-stringified then parsed back). */
export interface StoredToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | undefined;
  isError: boolean | undefined;
}

/** A chat message row from the DB. */
export interface StoredMessage {
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: string | null; // JSON-stringified array of StoredToolCall | null
  attachments?: Array<{ storagePath: string; mimeType: string }>;
}

/** An image attachment ready for the LLM (base64-encoded, read from disk). */
export interface ImageContent {
  type: "image";
  data: string; // base64-encoded image data
  mimeType: string; // e.g. "image/webp"
}

/** Resolved model info from the Pi agent session. */
export interface ResolvedModel {
  api: string | undefined;
  provider: string | undefined;
  id: string | undefined;
}

// ─── Tool Result Normalization ───────────────────────────────────────────────

/**
 * Normalize a tool execution result to a plain text string.
 *
 * Pi custom tools return `{ content: [{ type: "text", text: "..." }] }`.
 * This extracts the text content instead of JSON-stringifying the whole object,
 * which would double-encode the content on history replay.
 *
 * @param result - The raw result from a tool's execute() function or from a `tool_execution_end` event.
 * @returns The normalized text string to store in the DB and replay as toolResult content.
 *
 * @example
 * ```ts
 * // Tool returns structured result
 * normalizeToolResult({ content: [{ type: "text", text: "hello" }] })
 * // → "hello"
 *
 * // Already a string (e.g. from an error path)
 * normalizeToolResult("error message")
 * // → "error message"
 *
 * // Fallback for unexpected shapes
 * normalizeToolResult({ foo: 42 })
 * // → '{"foo":42}'
 * ```
 */
export function normalizeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as Record<string, unknown>).content)
  ) {
    const content = (result as Record<string, unknown>).content as unknown[];
    return content
      .filter(
        (c) =>
          c &&
          typeof c === "object" &&
          "type" in c &&
          (c as Record<string, unknown>).type === "text",
      )
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return JSON.stringify(result);
}

// ─── History Reconstruction ─────────────────────────────────────────────────

/**
 * Build the full toolResult message for replay.
 *
 * Uses `toolCallId` (not `toolUseId`) so that the pi-ai provider adapters
 * (Anthropic → `tool_use_id`, OpenAI → `tool_call_id`, Bedrock → `toolUseId`)
 * can correctly map the ID. Using the wrong key results in `undefined` being
 * sent to the API, breaking tool result linkage and cache hits.
 */
export function buildToolResultMessage(
  toolCall: StoredToolCall,
  timestamp: number,
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    content: [{ type: "text", text: toolCall.result ?? "(no result)" }],
    timestamp,
  };
}

/**
 * Build an assistant message for replay with content blocks in canonical order:
 * thinking → text → toolCall.
 *
 * Uses the resolved model's `api`, `provider`, and `id` so that
 * `transformMessages` in pi-ai treats the replayed message as same-model
 * (`isSameModel = true`). If these don't match, thinking blocks are downgraded
 * to plain text and tool signatures are stripped — breaking cache hits.
 */
export function buildAssistantMessage(
  content: string | undefined,
  thinking: string | null,
  toolCalls: StoredToolCall[] | null,
  model: ResolvedModel | undefined,
  timestamp: number,
): Record<string, unknown> {
  // Build content blocks in canonical order: thinking → text → toolCall
  const assistantContent: unknown[] = [];

  if (thinking) {
    assistantContent.push({ type: "thinking", thinking });
  }
  if (content) {
    assistantContent.push({ type: "text", text: content });
  }
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      assistantContent.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      });
    }
  }

  return {
    role: "assistant",
    content: assistantContent,
    api: model?.api,
    provider: model?.provider,
    model: model?.id,
    stopReason: toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn",
    timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  };
}

/**
 * Build a user message for replay.
 *
 * When images are present, the content array is:
 * [{ type: "text", text }, { type: "image", data, mimeType }, ...]
 *
 * The image data must be byte-identical to what was sent on the original turn
 * to ensure LLM provider cache hits. This is guaranteed because images are
 * re-encoded to deterministic WebP on upload, then read back from disk.
 */
export function buildUserMessage(
  content: string,
  timestamp: number,
  images?: ImageContent[],
): Record<string, unknown> {
  const contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: content }];

  if (images && images.length > 0) {
    for (const img of images) {
      contentBlocks.push({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      });
    }
  }

  return {
    role: "user",
    content: contentBlocks,
    timestamp,
  };
}

/**
 * Parse a JSON-stringified toolCalls field from a stored message.
 * Returns null if the field is null or contains malformed JSON.
 */
export function parseStoredToolCalls(toolCallsJson: string | null): StoredToolCall[] | null {
  if (!toolCallsJson) return null;
  try {
    const parsed = JSON.parse(toolCallsJson);
    if (Array.isArray(parsed)) return parsed as StoredToolCall[];
    return null;
  } catch {
    return null;
  }
}

/**
 * Options for building history messages.
 */
export interface BuildHistoryOptions {
  api: string | undefined;
  provider: string | undefined;
  id: string | undefined;
  /**
   * Pre-loaded image data for user messages with attachments.
   * Map from message index (in storedMessages, 0-based) to ImageContent[].
   *
   * Images must be read from the deterministic WebP files on disk to ensure
   * byte-identical base64 data across turns — critical for cache hits.
   */
  imageCache?: Map<number, ImageContent[]>;
}

/**
 * Reconstruct the full history message list from stored DB messages.
 *
 * This is the main entry point: given stored messages and the resolved model,
 * it produces the list of messages that should be injected into the agent
 * state before sending the next user prompt.
 *
 * The output must be byte-identical to what the live agent produced for
 * the same conversation, to ensure LLM provider cache hits.
 */
export function buildHistoryMessages(
  storedMessages: StoredMessage[],
  options: BuildHistoryOptions,
): Record<string, unknown>[] {
  const history: Record<string, unknown>[] = [];
  const timestamp = Date.now();

  // All messages except the last one (which is the current user prompt)
  const historyMessages = storedMessages.slice(0, -1);

  for (let i = 0; i < historyMessages.length; i++) {
    const m = historyMessages[i]!;
    if (m.role === "user") {
      // Look up pre-loaded images for this message (if any)
      const images = options.imageCache?.get(i);
      history.push(buildUserMessage(m.content, timestamp, images));
    } else if (m.role === "assistant") {
      const toolCalls = parseStoredToolCalls(m.toolCalls);

      history.push(
        buildAssistantMessage(
          m.content,
          m.thinking,
          toolCalls,
          {
            api: options.api,
            provider: options.provider,
            id: options.id,
          },
          timestamp,
        ),
      );

      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          history.push(buildToolResultMessage(tc, timestamp));
        }
      }
    }
  }

  return history;
}
