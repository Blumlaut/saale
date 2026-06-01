"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";

interface KeyboardShortcutsProviderProps {
  children: React.ReactNode;
}

/**
 * Provides global keyboard shortcuts for the dashboard.
 */
export function KeyboardShortcutsProvider({ children }: KeyboardShortcutsProviderProps) {
  const router = useRouter();
  const pathname = usePathname();

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
        router.push("/dashboard/chat");
      }

      // Cmd/Ctrl + 1 — Chat
      if (mod && e.key === "1") {
        e.preventDefault();
        router.push("/dashboard/chat");
      }

      // Cmd/Ctrl + 2 — Mail
      if (mod && e.key === "2") {
        e.preventDefault();
        router.push("/dashboard/mail");
      }

      // Cmd/Ctrl + 3 — Tasks
      if (mod && e.key === "3") {
        e.preventDefault();
        router.push("/dashboard/tasks");
      }

      // Cmd/Ctrl + , — Settings
      if (mod && e.key === ",") {
        e.preventDefault();
        router.push("/dashboard/settings");
      }

      // / — Focus search (when not in input)
      if (e.key === "/" && !isInput) {
        e.preventDefault();
        // Dispatch custom event for search bar to listen
        window.dispatchEvent(new CustomEvent("focus-search"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, pathname]);

  return <>{children}</>;
}
