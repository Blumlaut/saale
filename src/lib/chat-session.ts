import { fetchJson, postJson } from "@/lib/http";
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
 * @param options - Optional config including `temporary` flag for auto-delete on close.
 */
export async function createChatSession(options?: {
  temporary?: boolean;
}): Promise<{ id: string }> {
  // Fetch user settings for default model
  let settings: UserSettings | null = null;

  try {
    const data = await fetchJson<{ settings: UserSettings }>("/api/settings");
    settings = data.settings ?? null;
  } catch {
    // Ignore — session will be created without model info
  }

  const data = await postJson<{ session: { id: string } }>("/api/chat/sessions", {
    title: "New Chat",
    temporary: options?.temporary || false,
    modelProvider: settings?.defaultModelProvider || undefined,
    modelName: settings?.defaultModelName || undefined,
    thinkingLevel: settings?.defaultThinkingLevel || DEFAULT_THINKING_LEVEL_SETTING,
    toolConfig: settings?.defaultToolConfig || undefined,
  });

  return data.session;
}
