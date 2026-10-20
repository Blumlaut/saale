"use client";

import { useState, useRef, useCallback, useEffect, useImperativeHandle, useMemo } from "react";
import { insertQuote as insertQuoteAtCaret } from "@/lib/chat/quote-insert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Paperclip,
  Send,
  Loader2,
  ListPlus,
  Wrench,
  X,
  FileText,
  File as FileIcon,
} from "lucide-react";
import { cn, formatFileSize } from "@/lib/utils";
import { TOOL_CATEGORIES, type ToolConfig } from "@/lib/pi/tool-categories";
import { searchCommands } from "@/lib/commands/catalog";
import { SlashCommandMenu } from "./slash-command-menu";
import type { TokenUsage } from "./types";
import { ContextCircle } from "./token-usage-display";

export type { ToolConfig };
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
  /** Current composer text. owned by the parent so drafts survive navigation. */
  value: string;
  onValueChange: (value: string) => void;
  isLoading: boolean;
  onStop: () => void;
  toolConfig?: ToolConfig;
  onToggleTool?: (category: string) => void;
  tokenUsage?: TokenUsage | null;
  isCompacting?: boolean;
  onCompact?: () => void;
}

/** The composer's value while it is still just a command name: `/`, `/mo`, … */
const COMMAND_QUERY_PATTERN = /^\/([a-z0-9_-]*)$/i;

export function InputBar({
  ref,
  onSend,
  onCommand,
  value,
  onValueChange,
  isLoading,
  onStop,
  toolConfig,
  onToggleTool,
  tokenUsage,
  isCompacting,
  onCompact,
}: InputBarProps) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Slash-command picker ────────────────────────────────────────────
  // The query is non-null only while the composer holds a bare command name
  // once the user types a space the menu closes and the text is just a message
  // (or `/name args`, which the chat interface parses on send).
  const commandQuery = COMMAND_QUERY_PATTERN.exec(value)?.[1] ?? null;
  const commandMatches = useMemo(
    () => (commandQuery === null ? [] : searchCommands("web", commandQuery)),
    [commandQuery],
  );
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const commandMenuOpen =
    commandQuery !== null && !commandMenuDismissed && commandMatches.length > 0;

  // A new query starts a fresh highlight, and re-arms a dismissed menu.
  useEffect(() => {
    setCommandIndex(0);
    setCommandMenuDismissed(false);
  }, [commandQuery]);

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

  const hasToolToggle = onToggleTool !== undefined && toolConfig !== undefined;

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

  const handleSubmit = useCallback(() => {
    if (commandMenuOpen) {
      const highlighted = commandMatches[commandIndex];
      if (highlighted) {
        selectCommand(highlighted.name);
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
    commandMatches,
    commandIndex,
    selectCommand,
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
        setCommandIndex((index) => (index + 1) % commandMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((index) => (index - 1 + commandMatches.length) % commandMatches.length);
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

    if (e.key === "Enter" && !e.shiftKey) {
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
    <div className="border-border relative border-t pt-2">
      {commandMenuOpen && (
        <SlashCommandMenu
          commands={commandMatches}
          activeIndex={commandIndex}
          onSelect={selectCommand}
          onHighlight={setCommandIndex}
        />
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

      <div className="border-input relative flex items-center gap-2 rounded-none border bg-transparent px-3 py-2 md:rounded-2xl">
        {/* Tools toggle button */}
        {hasToolToggle && (
          <DropdownMenu>
            {/* Use div instead of Button to avoid nested <button> inside DropdownMenuTrigger */}
            <DropdownMenuTrigger>
              <div
                className="hover:text-foreground aria-expanded:text-foreground hover:bg-muted aria-expanded:bg-muted inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                aria-label="Toggle tools"
              >
                <Wrench className="h-4 w-4" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Available Tools</DropdownMenuLabel>
                {TOOL_CATEGORIES.map((category) => (
                  <DropdownMenuCheckboxItem
                    key={category.key}
                    checked={!!toolConfig[category.key]}
                    onCheckedChange={() => onToggleTool(category.key)}
                  >
                    {category.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
            className="h-9 w-9 shrink-0 rounded-full"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </Button>
        )}
        <Button
          className="liquid-glass-accent h-9 w-9 shrink-0 rounded-full transition-opacity disabled:opacity-50"
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
