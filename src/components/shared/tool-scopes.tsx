"use client";

import { Switch } from "@/components/ui/switch";

/**
 * The Chat and Coder switches of one row, in fixed columns so the page's header
 * labels line up over them.
 *
 * The column width lives here, not at the call sites: a row that added its own
 * wrapper would drift from the labels above it.
 */
export function ToolScopeHeader() {
  return (
    <div className="flex items-center justify-end gap-3 pb-1">
      <span className="console-label w-12 text-center">Chat</span>
      <span className="console-label w-12 text-center">Coder</span>
      <span className="w-6" aria-hidden />
    </div>
  );
}

interface ScopeSwitchesProps {
  /** What the switches enable, so a page listing several rows keeps them apart. */
  label: string;
  chat: boolean;
  coder: boolean;
  onChatChange: (checked: boolean) => void;
  onCoderChange: (checked: boolean) => void;
  /** A row the user has switched off elsewhere: show its scopes, change nothing. */
  disabled?: boolean;
}

/** One row's two scope switches. */
export function ScopeSwitches({
  label,
  chat,
  coder,
  onChatChange,
  onCoderChange,
  disabled,
}: ScopeSwitchesProps) {
  return (
    <>
      <span className="flex w-12 justify-center">
        <Switch
          checked={chat}
          onCheckedChange={onChatChange}
          aria-label={`${label} in chat`}
          disabled={disabled}
        />
      </span>
      <span className="flex w-12 justify-center">
        <Switch
          checked={coder}
          onCheckedChange={onCoderChange}
          aria-label={`${label} in coder chats`}
          disabled={disabled}
        />
      </span>
    </>
  );
}
