/**
 * Pi's extension UI, in the chat.
 *
 * An extension asks for a dialog through `ctx.ui`, which in the terminal is a
 * TUI overlay. Saale is a web app, so the dialogs become a card in the chat and
 * the fire-and-forget calls become notices, a status line and a panel above the
 * composer. Everything that needs to draw into a terminal is answered the way
 * Pi's own no-op context answers it: the extension sees "not available" and
 * keeps working.
 *
 * Pi runs a session's extensions in whichever process owns it, and the answer
 * arrives over Redis, so a dialog opened by the Telegram worker reaches the
 * browser like any other chat event.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { publishSessionEvent } from "@/lib/pi/session-events";
import { PLUGIN_UI_TIMEOUT_MS, requestPluginUi, type PluginUiResponse } from "./requests";

export interface ExtensionUiOptions {
  userId: string;
  sessionId: string;
}

/** Publish a fire-and-forget UI call; a failed publish must not fail the tool. */
function announce(sessionId: string, event: string, data: unknown): void {
  void publishSessionEvent(sessionId, event, data).catch((err: unknown) => {
    console.error(`Failed to publish plugin UI event "${event}":`, err);
  });
}

/** The parts of Pi's UI a browser can render. */
export function createExtensionUiContext(options: ExtensionUiOptions): ExtensionUIContext {
  const ask = async (
    kind: "select" | "confirm" | "input" | "editor",
    title: string,
    detail: {
      message?: string;
      options?: string[];
      placeholder?: string | undefined;
      prefill?: string | undefined;
    },
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<PluginUiResponse> => {
    const timeout = Math.min(opts?.timeout ?? PLUGIN_UI_TIMEOUT_MS, PLUGIN_UI_TIMEOUT_MS);
    return requestPluginUi(
      {
        sessionId: options.sessionId,
        userId: options.userId,
        kind,
        title,
        ...(detail.message === undefined ? {} : { message: detail.message }),
        ...(detail.options === undefined ? {} : { options: detail.options }),
        ...(detail.placeholder === undefined ? {} : { placeholder: detail.placeholder }),
        ...(detail.prefill === undefined ? {} : { prefill: detail.prefill }),
      },
      { signal: opts?.signal, timeoutMs: timeout },
    );
  };

  return {
    async select(title, choices, opts) {
      const answer = await ask("select", title, { options: choices }, opts);
      return answer.cancelled ? undefined : answer.value;
    },

    async confirm(title, message, opts) {
      const answer = await ask("confirm", title, { message }, opts);
      return answer.cancelled ? false : Boolean(answer.confirmed);
    },

    async input(title, placeholder, opts) {
      const answer = await ask("input", title, { placeholder }, opts);
      return answer.cancelled ? undefined : answer.value;
    },

    async editor(title, prefill) {
      const answer = await ask("editor", title, { prefill });
      return answer.cancelled ? undefined : answer.value;
    },

    notify(message, type) {
      announce(options.sessionId, "plugin_notice", { message, type: type ?? "info" });
    },

    setStatus(key, text) {
      announce(options.sessionId, "plugin_status", { key, text: text ?? null });
    },

    setWidget(key, content, widgetOptions) {
      // A component factory draws into a terminal; only lines cross over.
      const lines = content === undefined || Array.isArray(content) ? content : undefined;
      announce(options.sessionId, "plugin_widget", {
        key,
        lines: lines ?? null,
        placement: widgetOptions?.placement ?? "aboveEditor",
      });
    },

    setEditorText(text) {
      announce(options.sessionId, "plugin_composer_text", { text });
    },

    pasteToEditor(text) {
      announce(options.sessionId, "plugin_composer_text", { text });
    },

    // ── Terminal-only: answered as unavailable, the same as Pi's no-op UI ──
    onTerminalInput() {
      return () => {};
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom<T>(): Promise<T> {
      return undefined as T;
    },
    getEditorText() {
      return "";
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      // Extensions that render terminal components have nothing to draw here.
      return undefined as unknown as Theme;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching is not available in the chat" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}
