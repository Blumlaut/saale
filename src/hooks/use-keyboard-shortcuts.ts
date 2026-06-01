"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface KeyboardShortcutsOptions {
  onNewChat?: () => void;
  onSearch?: () => void;
  onCompose?: () => void;
  onSend?: () => void;
}

/**
 * Global keyboard shortcuts hook.
 * Registers keyboard shortcuts for common actions.
 */
export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Don't trigger shortcuts when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Cmd/Ctrl + N — New chat
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        options.onNewChat?.();
        router.push("/dashboard/chat");
      }

      // Cmd/Ctrl + K — Search (handled by dashboard-nav)
      if (mod && e.key.toLowerCase() === "k") {
        // Already handled
      }

      // Cmd/Ctrl + C — Compose email (only outside inputs)
      if (mod && !isInput && e.key.toLowerCase() === "c") {
        // Don't override copy — only trigger if not selecting text
        if (!window.getSelection()?.toString()) {
          e.preventDefault();
          options.onCompose?.();
        }
      }

      // Enter — Send message (only when focused on input)
      if (e.key === "Enter" && !e.shiftKey && isInput) {
        // Let the input bar handle this
      }

      // Escape — Close dialogs/dropdowns
      if (e.key === "Escape") {
        // Let components handle this
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, options]);
}
