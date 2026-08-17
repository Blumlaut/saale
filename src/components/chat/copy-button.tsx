"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

const COPIED_RESET_MS = 2000;

interface CopyButtonProps {
  /** Text to write to the clipboard. */
  text: string;
  /** Accessible name, also used as the hover tooltip. */
  label: string;
  /** Caller-provided styling for the icon button (e.g. hover reveal). */
  className?: string;
}

/**
 * Small icon button that copies `text` to the clipboard and briefly shows a
 * check icon as feedback. Callers control the look via `className`.
 */
export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the reset timer on unmount so it can't fire on a dead component
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch (err) {
      console.error("Failed to copy text to clipboard:", err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={className}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
