"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, patchJson } from "@/lib/http";
import { broadcastChatRenamed } from "@/lib/chat/session-events";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-config";

/**
 * Session metadata state: title, model, thinking level and tool config, plus
 * their persistence. Extracted from ChatInterface so the component only
 * orchestrates messages/streaming while this hook owns the session settings.
 */

interface SessionData {
  title?: string;
  modelProvider?: string;
  modelName?: string;
  defaultModel?: { provider: string; name: string } | null;
  thinkingLevel?: string;
  toolConfig?: ToolConfig;
}

const MODEL_PERSIST_DEBOUNCE_MS = 300;

export function useChatSessionState(sessionId: string) {
  const [sessionTitle, setSessionTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelId, setModelId] = useState("");
  // What answers while the chat has no model of its own.
  const [defaultModelId, setDefaultModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [toolConfig, setToolConfig] = useState<ToolConfig>(DEFAULT_TOOL_CONFIG);

  // The title the lists outside this component are showing. A chat is named by
  // its first message, server-side, so the only way a sidebar learns about it
  // is this comparison: nothing here was clicked.
  const titleRef = useRef("");

  const applyTitle = useCallback((title: string) => {
    if (!title || title === titleRef.current) return;
    titleRef.current = title;
    setSessionTitle(title);
    broadcastChatRenamed();
  }, []);

  const loadSessionTitle = useCallback(async () => {
    try {
      const data = await fetchJson<{ session: { title: string } }>(
        `/api/chat/sessions/${sessionId}`,
      );
      if (data.session?.title) applyTitle(data.session.title);
    } catch (err) {
      console.error("Failed to load session title:", err);
    }
  }, [sessionId, applyTitle]);

  // ── Apply server session metadata (from GET /messages) ─────────────────
  // Syncing the prev refs here prevents the debounced persistence effect from
  // echoing server data straight back as a redundant PATCH after every reload.
  const prevModelIdRef = useRef(modelId);
  const prevThinkingLevelRef = useRef(thinkingLevel);

  const applySession = useCallback(
    (session?: SessionData) => {
      if (!session) return;
      // A reload after a run is when a fresh chat's auto title arrives, so the
      // sidebars follow without a request of their own.
      if (session.title) applyTitle(session.title);
      if (session.modelProvider && session.modelName) {
        const modelStr = `${session.modelProvider}/${session.modelName}`;
        setModelId(modelStr);
        prevModelIdRef.current = modelStr;
      }
      setDefaultModelId(
        session.defaultModel ? `${session.defaultModel.provider}/${session.defaultModel.name}` : "",
      );
      if (session.thinkingLevel) {
        setThinkingLevel(session.thinkingLevel);
        prevThinkingLevelRef.current = session.thinkingLevel;
      }
      if (session.toolConfig) {
        setToolConfig({ ...DEFAULT_TOOL_CONFIG, ...session.toolConfig });
      }
    },
    [applyTitle],
  );

  const saveTitle = useCallback(
    async (newTitle: string) => {
      const sanitized = newTitle.replace(/\0/g, "").slice(0, 50).trim();
      if (!sanitized) return;
      titleRef.current = sanitized;
      setSessionTitle(sanitized);
      setEditingTitle(false);
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, { title: sanitized });
        broadcastChatRenamed();
      } catch (err) {
        console.error("Failed to save session title:", err);
      }
    },
    [sessionId],
  );

  const toggleTool = useCallback(
    async (category: keyof ToolConfig) => {
      const updated = { ...toolConfig, [category]: !toolConfig[category] };
      setToolConfig(updated);
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, { toolConfig: updated });
      } catch (err) {
        console.error("Failed to save tool config:", err);
      }
    },
    [toolConfig, sessionId],
  );

  // ── Persist model/thinking changes (debounced) ─────────────────────────
  // IMPORTANT: this effect must be declared BEFORE the prev-ref sync effect
  // below. effects run in declaration order, and the sync would otherwise
  // mask the change before the debounce gets to compare against it.
  useEffect(() => {
    if (!modelId && thinkingLevel === "off") return;
    if (modelId === prevModelIdRef.current && thinkingLevel === prevThinkingLevelRef.current)
      return;

    const saveTimer = setTimeout(async () => {
      const [provider, ...modelParts] = modelId.split("/");
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, {
          modelProvider: provider || undefined,
          modelName: modelParts.join("/") || undefined,
          thinkingLevel,
        });
      } catch (err) {
        console.error("Failed to persist model/thinking settings:", err);
      }
    }, MODEL_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer);
  }, [modelId, thinkingLevel, sessionId]);

  // Keep the prev refs in sync with the latest committed values (runs after
  // every render).
  useEffect(() => {
    prevModelIdRef.current = modelId;
    prevThinkingLevelRef.current = thinkingLevel;
  });

  return {
    sessionTitle,
    editingTitle,
    titleDraft,
    setTitleDraft,
    setEditingTitle,
    modelId,
    setModelId,
    defaultModelId,
    thinkingLevel,
    setThinkingLevel,
    toolConfig,
    applySession,
    loadSessionTitle,
    saveTitle,
    toggleTool,
  };
}
