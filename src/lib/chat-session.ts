import { fetchJson, postJson } from "@/lib/http";
import type { ToolConfig } from "@/lib/pi/tool-config";

interface UserSettings {
  defaultModelProvider?: string;
  defaultModelName?: string;
  defaultThinkingLevel?: string;
  defaultToolConfig?: ToolConfig;
}

/**
 * Create a new chat session, optionally using user settings for default model.
 */
export async function createChatSession(): Promise<{ id: string }> {
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
    modelProvider: settings?.defaultModelProvider || undefined,
    modelName: settings?.defaultModelName || undefined,
    thinkingLevel: settings?.defaultThinkingLevel || "off",
    toolConfig: settings?.defaultToolConfig || undefined,
  });

  return data.session;
}
