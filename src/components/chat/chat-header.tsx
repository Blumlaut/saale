"use client";

import { Input } from "@/components/ui/input";
import { ModelPicker } from "@/components/shared/model-picker";
import { ChatSettingsSheet, type ChatSettings } from "./chat-settings-sheet";
import { Button } from "@/components/ui/button";
import { MobileSessionSheet } from "./mobile-session-sheet";
import { TemporaryToggle } from "./temporary-toggle";
import { Loader2, Ghost, Pencil, MessageSquarePlus, Radar } from "lucide-react";
import { ShareButton } from "./share-button";
import { cn } from "@/lib/utils";

interface ChatHeaderProps {
  sessionTitle: string;
  editingTitle: boolean;
  titleDraft: string;
  temporaryMode: boolean;
  isLoading: boolean;
  sessionId: string;
  modelId: string;
  /** Model that answers while the chat has none picked (the default). */
  defaultModelId: string;
  onModelChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveTitle: (title: string) => void;
  onTemporaryChange: (checked: boolean) => void;
  /** False when the view has no temporary mode (a coder chat). */
  onNewChat: () => void;
  linksCount: number;
  /** Thinking level and tools, opened from the button beside the model. */
  settings?: ChatSettings;
  linksOpen: boolean;
  onToggleLinks: () => void;
  /** Replaces the chat session sheet on phones (the coder chat lists a project). */
  mobileListTrigger?: React.ReactNode;
  /** Extra header controls, rendered last (the coder chat's worktree panel). */
  extraActions?: React.ReactNode;
  /** Hide the temporary-mode toggle. a coder chat is bound to its worktree. */
  hideTemporaryToggle?: boolean;
}

/**
 * The single chat toolbar: session title, temporary mode, sharing, model &
 * thinking level, and a new-chat action. There is no separate page header
 * this row is the page header.
 */
export function ChatHeader({
  sessionTitle,
  editingTitle,
  titleDraft,
  temporaryMode,
  isLoading,
  sessionId,
  modelId,
  defaultModelId,
  onModelChange,
  onTitleChange,
  onStartEditing,
  onCancelEditing,
  onSaveTitle,
  onTemporaryChange,
  onNewChat,
  linksCount,
  settings,
  linksOpen,
  onToggleLinks,
  mobileListTrigger,
  extraActions,
  hideTemporaryToggle,
}: ChatHeaderProps) {
  return (
    <div className="border-border/30 flex items-center gap-1.5 border-b px-3 py-2 md:gap-2 md:px-4 md:py-2.5">
      {/* Mobile: session list */}
      <div className="shrink-0 md:hidden">
        {mobileListTrigger ?? (
          <MobileSessionSheet activeSessionId={sessionId} onNewChat={onNewChat} />
        )}
      </div>

      {/* Editable session title */}
      {editingTitle ? (
        <Input
          value={titleDraft}
          onChange={(e) => onTitleChange(e.target.value.slice(0, 50))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSaveTitle(titleDraft);
            } else if (e.key === "Escape") {
              onCancelEditing();
            }
          }}
          onBlur={() => onSaveTitle(titleDraft)}
          autoFocus
          className="h-6 w-40 text-sm font-semibold"
        />
      ) : (
        <button
          onClick={onStartEditing}
          className="group/title hover:bg-accent/60 -ml-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-sm font-semibold transition-colors"
        >
          <span className="max-w-[140px] truncate md:max-w-[300px]">{sessionTitle || "Chat"}</span>
          <Pencil className="text-muted-foreground h-3 w-3 opacity-0 transition-opacity group-hover/title:opacity-70 any-pointer-coarse:opacity-70" />
        </button>
      )}
      {temporaryMode && (
        // Redundant on mobile. the toggle icon already shows the state, and
        // the label overflows narrow rows.
        <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:flex">
          <Ghost className="h-3 w-3" />
          temporary
        </span>
      )}
      {isLoading && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}

      <ShareButton sessionId={sessionId} />

      {/* Temporary mode, model & thinking selectors, new chat */}
      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-1.5">
        {linksCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "relative h-8 w-8 shrink-0 md:h-9",
              linksOpen && "bg-accent/70 text-foreground",
            )}
            onClick={onToggleLinks}
            title="Linked watchers"
            aria-pressed={linksOpen}
          >
            <Radar className="h-4 w-4" />
            <span className="bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none tabular-nums">
              {linksCount}
            </span>
          </Button>
        )}
        {!hideTemporaryToggle && (
          <TemporaryToggle checked={temporaryMode} onChange={onTemporaryChange} />
        )}
        {/* The model is the one setting worth reading without opening anything. */}
        <ModelPicker
          value={modelId}
          onChange={onModelChange}
          fallback={defaultModelId}
          placeholder="No Model"
          triggerClassName="max-w-[32vw] md:max-w-none"
        />
        {settings && <ChatSettingsSheet settings={settings} />}
        {extraActions}
        <Button
          className="flex h-8 w-8 shrink-0 items-center gap-1.5 md:h-9 md:w-auto md:px-3"
          size="icon"
          onClick={onNewChat}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden md:inline">New Chat</span>
        </Button>
      </div>
    </div>
  );
}
