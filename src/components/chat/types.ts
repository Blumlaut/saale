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

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | undefined;
  toolCalls: ToolCallData[] | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
  attachments: AttachmentData[] | undefined;
}
