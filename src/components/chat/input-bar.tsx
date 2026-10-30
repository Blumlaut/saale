"use client";

import { useState, useRef, useCallback, useEffect, useImperativeHandle, useMemo } from "react";
import { insertQuote as insertQuoteAtCaret } from "@/lib/chat/quote-insert";
import { insertAtCaret } from "@/lib/chat/caret-insert";
import { useVoiceAvailability } from "@/hooks/use-voice-availability";
import { VoiceInputButton } from "./voice-input-button";
import { isSendKey } from "@/lib/chat/enter-to-send";
import { Button } from "@/components/ui/button";
import { UploadProgressBar } from "@/components/ui/upload-progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Paperclip,
  Send,
  Loader2,
  ListPlus,
  X,
  FileText,
  File as FileIcon,
  FolderGit2,
} from "lucide-react";
import { cn, formatFileSize } from "@/lib/utils";
import { searchCommands } from "@/lib/commands/catalog";
import { searchPrompts, type PromptPickerItem } from "@/lib/prompts/resolve";
import type { UploadProgress } from "@/lib/files/upload-client";
import { SlashCommandMenu, type SlashMenuItem } from "./slash-command-menu";
import type { TokenUsage } from "./types";
import { ContextCircle } from "./token-usage-display";

export type { TokenUsage };

interface PendingFile {
  file: File;
  /** Object URL for image previews (null for non-image files). */
  previewUrl: string | null;
}

/** Imperative API. the message list quotes a selection into the caret. */
export interface InputBarHandle {
  insertQuote: (quote: string) => void;
  /** Queue files for the next send. how the chat surface hands over a drop. */
  addFiles: (files: File[]) => void;
}

interface InputBarProps {
  /** React 19 ref-as-prop for the imperative API above. */
  ref?: React.Ref<InputBarHandle>;
  onSend: (message: string, files?: File[]) => void;
  /** Runs a slash command picked from the `/` menu. */
  onCommand?: (name: string) => void;
  /** The chat's prompts, listed alongside the commands under `/`. */
  prompts?: readonly PromptPickerItem[];
  /** Called when the `/` menu opens, so the prompts can be read again. */
  onPromptsRequested?: () => void;
  /** Current composer text. owned by the parent so drafts survive navigation. */
  value: string;
  onValueChange: (value: string) => void;
  isLoading: boolean;
  onStop: () => void;
  tokenUsage?: TokenUsage | null;
  isCompacting?: boolean;
  onCompact?: () => void;
  /** Bytes of the batch being sent, while they are still going up. */
  uploadProgress?: UploadProgress | null;
}

/** The composer's value while it is still just a command name: `/`, `/mo`, … */
const COMMAND_QUERY_PATTERN = /^\/([a-z0-9_-]*)$/i;

export function InputBar({
  ref,
  onSend,
  onCommand,
  prompts,
  onPromptsRequested,
  value,
  onValueChange,
  isLoading,
  onStop,
  tokenUsage,
  isCompacting,
  onCompact,
  uploadProgress,
}: InputBarProps) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const voiceEnabled = useVoiceAvailability();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Slash-command picker ────────────────────────────────────────────
  // The query is non-null only while the composer holds a bare command name
  // once the user types a space the menu closes and the text is just a message
  // (or `/name args`, which the chat interface parses on send).
  const commandQuery = COMMAND_QUERY_PATTERN.exec(value)?.[1] ?? null;
  const menuItems = useMemo<SlashMenuItem[]>(() => {
    if (commandQuery === null) return [];
    const commands = searchCommands("web", commandQuery).map<SlashMenuItem>((meta) => ({
      kind: "command",
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
    }));
    const promptItems = searchPrompts(prompts ?? [], commandQuery).map<SlashMenuItem>((prompt) => ({
      kind: "prompt",
      name: prompt.name,
      description: prompt.description,
      icon: prompt.source === "project" ? FolderGit2 : FileText,
      hint: prompt.argumentHint,
    }));
    return [...commands, ...promptItems];
  }, [commandQuery, prompts]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const commandMenuOpen = commandQuery !== null && !commandMenuDismissed && menuItems.length > 0;

  // A new query starts a fresh highlight, and re-arms a dismissed menu.
  useEffect(() => {
    setCommandIndex(0);
    setCommandMenuDismissed(false);
  }, [commandQuery]);

  // Typing a slash re-reads the prompts, whose sources change while the chat is
  // open: a project template the agent committed, a prompt saved in another
  // tab. It fires on the slash, not on the menu opening, because a name that
  // matches nothing loaded yet renders no menu to open.
  const commandTyped = commandQuery !== null;
  useEffect(() => {
    if (commandTyped) onPromptsRequested?.();
  }, [commandTyped, onPromptsRequested]);

  const autoResize = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, []);

  // Insert a quoted selection at the caret (or at the end when the composer
  // was never focused), then focus it so the user keeps typing.
  const insertQuote = useCallback(
    (quote: string) => {
      const el = textareaRef.current;
      // selectionStart is only meaningful while the composer holds focus;
      // otherwise the quote lands at the end of the draft.
      const caret =
        el && document.activeElement === el ? (el.selectionStart ?? value.length) : value.length;
      const next = insertQuoteAtCaret(value, quote, caret);
      if (next.value === value) return; // whitespace-only selection. nothing to insert
      if (el) {
        // Set the DOM value synchronously (before the state round-trip) so
        // the caret placement below targets the new text, not the old.
        el.value = next.value;
        el.focus();
        el.setSelectionRange(next.cursor, next.cursor);
        autoResize();
      }
      onValueChange(next.value);
    },
    [value, onValueChange, autoResize],
  );

  const insertSpokenText = useCallback(
    (transcript: string) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const next = insertAtCaret(value, transcript, caret);
      if (next === value) return;
      if (el) {
        el.value = next;
        el.focus();
        el.setSelectionRange(next.length, next.length);
        autoResize();
      }
      onValueChange(next);
    },
    [value, onValueChange, autoResize],
  );

  const canSend = value.trim().length > 0 || pendingFiles.length > 0;
  // A compaction holds the session too: what the composer sends now is queued,
  // so it has to say so. even though Stop is only offered for a generation.
  const willQueue = isLoading || !!isCompacting;

  /** Run the command picked from the menu, and hand the composer back. */
  const selectCommand = useCallback(
    (name: string) => {
      onCommand?.(name);
      onValueChange("");
      setCommandMenuDismissed(true);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
    },
    [onCommand, onValueChange],
  );

  /** Drop a prompt's `/name ` in the composer, ready for its arguments. */
  const selectPrompt = useCallback(
    (name: string) => {
      const next = `/${name} `;
      onValueChange(next);
      setCommandMenuDismissed(true);
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
        autoResize();
      }
    },
    [onValueChange, autoResize],
  );

  const selectMenuItem = useCallback(
    (item: SlashMenuItem) => {
      if (item.kind === "prompt") selectPrompt(item.name);
      else selectCommand(item.name);
    },
    [selectPrompt, selectCommand],
  );

  const handleSubmit = useCallback(() => {
    if (commandMenuOpen) {
      const highlighted = menuItems[commandIndex];
      if (highlighted) {
        selectMenuItem(highlighted);
        return;
      }
    }
    if (!canSend) return;
    const files = pendingFiles.map((f) => f.file);
    onSend(value.trim(), files.length > 0 ? files : undefined);
    onValueChange("");
    setPendingFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [
    commandMenuOpen,
    menuItems,
    commandIndex,
    selectMenuItem,
    value,
    pendingFiles,
    canSend,
    onSend,
    onValueChange,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (commandMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((index) => (index + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((index) => (index - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCommandMenuDismissed(true);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleSubmit();
        return;
      }
    }

    if (isSendKey(e)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Accept any file type. images are previewed as thumbnails, everything
  // else as a file chip. The server stores it and the agent gets a copy in
  // its terminal workspace.
  const addFiles = useCallback((files: FileList | File[]) => {
    const accepted: File[] = [];
    for (const file of files) {
      if (file instanceof File) {
        accepted.push(file);
      }
    }

    if (accepted.length === 0) return;

    setPendingFiles((prev) => {
      const newFiles: PendingFile[] = accepted.map((file) => ({
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      }));
      return [...prev, ...newFiles];
    });

    // Focus textarea after adding files
    textareaRef.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({ insertQuote, addFiles }), [insertQuote, addFiles]);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      addFiles(files);
    }
    if (e.target) e.target.value = "";
  };

  // React 19 no longer delegates the native `paste` event to onPaste, so
  // attach a DOM listener directly. Only real files (kind === "file") are
  // captured. plain text pastes (kind "string") keep working as text.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        addFiles(pastedFiles);
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [addFiles]);

  // Revoke object URLs as soon as a preview disappears (and on unmount).
  const livePreviewUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(pendingFiles.map((f) => f.previewUrl).filter((u): u is string => !!u));
    for (const url of livePreviewUrlsRef.current) {
      if (!current.has(url)) URL.revokeObjectURL(url);
    }
    livePreviewUrlsRef.current = current;
  }, [pendingFiles]);
  useEffect(() => {
    return () => {
      for (const url of livePreviewUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  // The value also changes from outside (restored draft, cleared on send).
  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  return (
    <div className="border-border/30 relative border-t pt-2">
      {commandMenuOpen && (
        <SlashCommandMenu
          items={menuItems}
          activeIndex={commandIndex}
          onSelect={selectMenuItem}
          onHighlight={setCommandIndex}
        />
      )}

      {/* A send in flight. the files leave the strip here and report bytes instead */}
      {uploadProgress && (
        <div className="px-3 pt-2">
          <UploadProgressBar progress={uploadProgress} />
        </div>
      )}

      {/* Attachment preview strip */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-2">
          {pendingFiles.map((pending, index) => (
            <div key={index} className="group relative">
              {pending.previewUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URLs for preview */}
                  <img
                    src={pending.previewUrl}
                    alt={pending.file.name}
                    className="ring-border/50 h-14 w-14 rounded-lg object-cover ring-1"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={() => removeFile(index)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 opacity-70 transition-opacity group-hover:opacity-100"
                    aria-label={`Remove ${pending.file.name}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <div className="border-border/30 bg-muted/50 hover:bg-accent/60 flex max-w-[220px] items-center gap-2 rounded-lg border px-2.5 py-1.5">
                  {pending.file.type.startsWith("text/") ? (
                    <FileText className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : (
                    <FileIcon className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="max-w-[140px] truncate text-xs font-medium">
                      {pending.file.name}
                    </p>
                    <p className="text-muted-foreground text-[11px]">
                      {formatFileSize(pending.file.size)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeFile(index)}
                    className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
                    aria-label={`Remove ${pending.file.name}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-input bg-card relative flex items-center gap-2 rounded-none border px-3 py-2 md:rounded-2xl">
        {/* File upload button. any file type */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {voiceEnabled && <VoiceInputButton onText={insertSpokenText} />}

        {/* Textarea. stays editable while Pi works so messages can be queued */}
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message Saale..."
          className={cn(
            "max-h-[200px] min-h-[40px] flex-1 resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0",
            "placeholder:text-muted-foreground",
          )}
          rows={1}
        />

        {/* Context usage indicator */}
        <ContextCircle
          usage={tokenUsage ?? null}
          isCompacting={!!isCompacting}
          onCompact={onCompact ?? (() => {})}
        />

        {/* Stop (while generating) + Send/Queue */}
        {isLoading && (
          <Button
            variant="secondary"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </Button>
        )}
        <Button
          className="h-9 w-9 shrink-0 transition-opacity disabled:opacity-50"
          size="icon"
          onClick={handleSubmit}
          disabled={!canSend}
          aria-label={willQueue ? "Queue message" : "Send message"}
          title={willQueue ? "Queue. sent when the current response finishes" : undefined}
        >
          {willQueue ? <ListPlus className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
