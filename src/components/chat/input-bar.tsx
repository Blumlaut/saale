"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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
import { Paperclip, Send, Loader2, Wrench, X, FileText, File as FileIcon } from "lucide-react";
import { cn, formatFileSize } from "@/lib/utils";
import { TOOL_CATEGORIES, type ToolConfig } from "@/lib/pi/tool-categories";
import { ContextCircle } from "./token-usage-display";

export type { ToolConfig };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  contextWindow: number;
}

interface PendingFile {
  file: File;
  /** Object URL for image previews (null for non-image files). */
  previewUrl: string | null;
}

interface InputBarProps {
  onSend: (message: string, files?: File[]) => void;
  isLoading: boolean;
  onStop: () => void;
  toolConfig?: ToolConfig;
  onToggleTool?: (category: string) => void;
  tokenUsage?: TokenUsage | null;
  isCompacting?: boolean;
  onCompact?: () => void;
}

export function InputBar({
  onSend,
  isLoading,
  onStop,
  toolConfig,
  onToggleTool,
  tokenUsage,
  isCompacting,
  onCompact,
}: InputBarProps) {
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasToolToggle = onToggleTool !== undefined && toolConfig !== undefined;

  const canSend = input.trim().length > 0 || pendingFiles.length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSend || isLoading) return;
    const files = pendingFiles.map((f) => f.file);
    onSend(input.trim(), files.length > 0 ? files : undefined);
    setInput("");
    setPendingFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, pendingFiles, canSend, isLoading, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Accept any file type — images are previewed as thumbnails, everything
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
  // captured — plain text pastes (kind "string") keep working as text.
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

  const autoResize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  return (
    <div className="border-border/30 border-t pt-2">
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
                <div className="border-border/30 flex max-w-[220px] items-center gap-2 rounded-lg border bg-white/5 px-2.5 py-1.5 hover:bg-white/10">
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

      <div className="liquid-glass-inner relative flex items-center gap-2 rounded-2xl border-0 px-3 py-2">
        {/* Tools toggle button */}
        {hasToolToggle && (
          <DropdownMenu>
            {/* Use div instead of Button to avoid nested <button> inside DropdownMenuTrigger */}
            <DropdownMenuTrigger>
              <div
                className="hover:text-foreground aria-expanded:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/20 aria-expanded:bg-white/20 dark:hover:bg-white/5"
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

        {/* File upload button — any file type */}
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

        {/* Textarea */}
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message Saale..."
          className={cn(
            "max-h-[200px] min-h-[40px] flex-1 resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0",
            "placeholder:text-muted-foreground",
          )}
          rows={1}
          disabled={isLoading}
        />

        {/* Context usage indicator */}
        <ContextCircle
          usage={tokenUsage ?? null}
          isCompacting={!!isCompacting}
          onCompact={onCompact ?? (() => {})}
        />

        {/* Send / Stop button */}
        {isLoading ? (
          <Button
            variant="secondary"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </Button>
        ) : (
          <Button
            className="liquid-glass-accent h-9 w-9 shrink-0 rounded-full transition-opacity disabled:opacity-50"
            size="icon"
            onClick={handleSubmit}
            disabled={!canSend}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
