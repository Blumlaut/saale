export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result: string | undefined;
  error: string | undefined;
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
  expiresAt: string;
  resolved?: boolean;
  approved?: boolean;
}

export interface CompactionData {
  tokensBefore: number;
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
  attachments: AttachmentData[] | undefined;
  approval?: ApprovalData;
  compaction?: CompactionData;
}
