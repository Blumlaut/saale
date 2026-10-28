import { fetchJson, postJson } from "@/lib/http";
import { sendChatMessage } from "@/lib/chat/send-message";
import { DEFAULT_THINKING_LEVEL_SETTING } from "@/lib/pi/thinking-levels";
import type { ToolConfig } from "@/lib/pi/tool-config";

interface UserSettings {
  defaultModelProvider?: string;
  defaultModelName?: string;
  defaultThinkingLevel?: string;
  defaultToolConfig?: ToolConfig;
}

/**
 * Create a new chat session, optionally using user settings for default model.
 * @param options - Optional config including `title` override and `temporary`
 *   flag for auto-delete on close.
 */
export async function createChatSession(options?: {
  title?: string;
  temporary?: boolean;
  /** Set to start a coder chat; the server applies the coder tool defaults. */
  projectId?: string;
}): Promise<{ id: string }> {
  // Fetch user settings for default model
  let settings: UserSettings | null = null;

  try {
    const data = await fetchJson<{ settings: UserSettings }>("/api/settings");
    settings = data.settings ?? null;
  } catch {
    // Ignore. session will be created without model info
  }

  const data = await postJson<{ session: { id: string } }>("/api/chat/sessions", {
    // A chat with no title of its own stays unnamed until its first message
    ...(options?.title ? { title: options.title } : {}),
    temporary: options?.temporary || false,
    modelProvider: settings?.defaultModelProvider || undefined,
    modelName: settings?.defaultModelName || undefined,
    thinkingLevel: settings?.defaultThinkingLevel || DEFAULT_THINKING_LEVEL_SETTING,
    // A coder chat's tools come from the coder defaults on the server, not
    // from the chat defaults fetched here.
    ...(options?.projectId
      ? { projectId: options.projectId }
      : { toolConfig: settings?.defaultToolConfig || undefined }),
  });

  return data.session;
}

/**
 * Open a chat and give it something to do.
 *
 * The message is written before the chat page opens: the page's stream claims
 * an unanswered message when it connects, so there is no second place that
 * starts a run.
 */
export async function startChatSession({
  message,
  ...options
}: {
  message: string;
  title?: string;
  temporary?: boolean;
  /** Set to start a coder chat; the server applies the coder tool defaults. */
  projectId?: string;
}): Promise<{ id: string }> {
  const session = await createChatSession(options);

  const result = await sendChatMessage(session.id, message);
  if (result.kind !== "ok") {
    const reason = result.kind === "error" ? result.message : result.kind;
    console.error(`Failed to send the first message of chat ${session.id}:`, reason);
    throw new Error(`Could not start the chat (${reason})`);
  }

  return session;
}
