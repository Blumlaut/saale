"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/shared/model-picker";
import { ThinkingSelector } from "./thinking-selector";
import { MobileSessionSheet } from "./mobile-session-sheet";
import { TemporaryToggle } from "./temporary-toggle";
import { Loader2, Settings2, ChevronDown, Ghost, Pencil, MessageSquarePlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShareButton } from "./share-button";

interface ChatHeaderProps {
  sessionTitle: string;
  editingTitle: boolean;
  titleDraft: string;
  temporaryMode: boolean;
  isLoading: boolean;
  sessionId: string;
  modelId: string;
  thinkingLevel: string;
  onTitleChange: (value: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveTitle: (title: string) => void;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  onTemporaryChange: (checked: boolean) => void;
  onNewChat: () => void;
}

/**
 * The single chat toolbar: session title, temporary mode, sharing, model &
 * thinking level, and a new-chat action. There is no separate page header —
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
  thinkingLevel,
  onTitleChange,
  onStartEditing,
  onCancelEditing,
  onSaveTitle,
  onModelChange,
  onThinkingChange,
  onTemporaryChange,
  onNewChat,
}: ChatHeaderProps) {
  const [provider, ...modelParts] = modelId.split("/");
  const modelName = modelParts.join("/");

  return (
    <div className="border-border/30 flex items-center gap-1.5 border-b px-3 py-2 md:gap-2 md:px-4 md:py-2.5">
      {/* Mobile: session list */}
      <div className="shrink-0 md:hidden">
        <MobileSessionSheet activeSessionId={sessionId} onNewChat={onNewChat} />
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
        // Redundant on mobile — the toggle icon already shows the state, and
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
        <TemporaryToggle checked={temporaryMode} onChange={onTemporaryChange} />
        <div className="hidden items-center gap-1 md:flex">
          <ModelPicker value={modelId} onChange={onModelChange} />
          <ThinkingSelector
            value={thinkingLevel}
            onChange={onThinkingChange}
            modelProvider={provider || undefined}
            modelName={modelName || undefined}
          />
        </div>
        <div className="md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="hover:bg-accent/60 inline-flex h-7 items-center gap-1 rounded px-1.5 text-sm transition-colors">
                <Settings2 className="h-3.5 w-3.5" />
                <ChevronDown className="h-3 w-3" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 pt-1.5 pb-1">
                <ModelPicker value={modelId} onChange={onModelChange} compact />
              </div>
              <div className="border-border/50 border-t px-2 pt-1.5 pb-1">
                <ThinkingSelector
                  value={thinkingLevel}
                  onChange={onThinkingChange}
                  modelProvider={provider || undefined}
                  modelName={modelName || undefined}
                />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          className="liquid-glass-accent flex h-8 w-8 shrink-0 items-center gap-1.5 rounded-full md:h-9 md:w-auto md:px-3"
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
