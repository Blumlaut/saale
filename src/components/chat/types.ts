export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result: string | undefined;
  error: string | undefined;
  /**
   * Safe one-line description set by the share endpoints in place of
   * `args`/`result`. Present only on redacted public-share payloads.
   */
  redacted?: string;
}

export interface AttachmentData {
  id: string;
  storageId: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

export interface ApprovalData {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * One-line "what is this call about", resolved server-side (ID-only
   * references look up the user's own records). Absent on pre-existing
   * requests. the card re-derives one from the arguments.
   */
  summary?: string | null;
  /**
   * The calls one decision stands in for, when it covers more than this call
   * a codemode script's approval covers the calls it announced. Mirrors
   * `ApprovalBatch` in `@/lib/pi/tool-approval-gate`.
   */
  batch?: ApprovalBatchData;
  expiresAt: string;
  resolved?: boolean;
  approved?: boolean;
}

/** The tool calls a single approval covers. */
export interface ApprovalBatchData {
  /** Tool names the approval covers; a call to any other tool still asks. */
  tools: string[];
  /** The tool can reach names its source does not show. */
  dynamic?: boolean;
}

export interface CompactionData {
  tokensBefore: number;
}

/**
 * Token usage for a generation, as published by the session event tracker.
 *
 * `input`/`output`/`cacheRead`/`cacheWrite`/`total` are billed totals,
 * cumulative over the run. they exclude prompt-cache reads from `input`, so
 * they must never be used to gauge how full the context is. `contextTokens`
 * carries that instead (Pi's own context accounting).
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Tokens Pi expects on the next request, or null when unknown. */
  contextTokens: number | null;
  contextWindow: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "approval" | "compaction";
  content: string;
  thinking: string | undefined;
  /** Provider error when the turn failed (stopReason "error"). */
  errorMessage?: string | undefined;
  toolCalls: ToolCallData[] | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
  /**
   * The server turn that produced this message (client-side only). Live turns
   * are also identified by their `streaming-{turnId}` id, but `message_saved`
   * renames them to their DB row. this tag survives that, so a replayed event
   * for a turn already on screen updates it instead of adding a second copy.
   */
  turnId?: string | undefined;
  /**
   * When this client learned the row id of a turn it streamed (client clock).
   * A reload's snapshot that was read before the save committed cannot contain
   * the row, so the merge needs to tell "not committed yet" from "deleted"
   * only a save this recent explains the absence (see `mergeMessagesWithLive`).
   */
  savedAt?: number | undefined;
  attachments: AttachmentData[] | undefined;
  approval?: ApprovalData;
  compaction?: CompactionData;
}
