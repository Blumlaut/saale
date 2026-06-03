"use client";

import { useState, useRef, useCallback } from "react";
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
import { Paperclip, Send, Loader2, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ToolConfig } from "@/lib/pi/tool-config";

export type { ToolConfig };

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface InputBarProps {
  onSend: (message: string, files?: File[]) => void;
  isLoading: boolean;
  onStop: () => void;
  toolConfig?: ToolConfig;
  onToggleTool?: (category: keyof ToolConfig) => void;
}

const TOOL_LABELS: Record<keyof ToolConfig, string> = {
  bash: "Bash",
  files: "Files",
  email: "Email",
  jobs: "Jobs",
  calendar: "Calendar",
  chatSearch: "Chat history",
  web: "Web",
};

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
]);

export function InputBar({ onSend, isLoading, onStop, toolConfig, onToggleTool }: InputBarProps) {
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasToolToggle = onToggleTool !== undefined && toolConfig !== undefined;

  const canSend = input.trim().length > 0 || pendingImages.length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSend || isLoading) return;
    const files = pendingImages.map((img) => img.file);
    onSend(input.trim(), files.length > 0 ? files : undefined);
    setInput("");
    setPendingImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, pendingImages, canSend, isLoading, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const addImages = useCallback((files: FileList | File[]) => {
    const imageFiles: File[] = [];
    for (const file of files) {
      if (file instanceof File && ALLOWED_IMAGE_TYPES.has(file.type)) {
        imageFiles.push(file);
      }
    }

    if (imageFiles.length === 0) return;

    setPendingImages((prev) => {
      const newImages: PendingImage[] = imageFiles.map((file) => ({
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      return [...prev, ...newImages];
    });

    // Focus textarea after adding images
    textareaRef.current?.focus();
  }, []);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      addImages(files);
    }
    if (e.target) e.target.value = "";
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages],
  );

  // Cleanup preview URLs on unmount
  useState(() => {
    return () => {
      for (const img of pendingImages) {
        URL.revokeObjectURL(img.previewUrl);
      }
    };
  });

  const autoResize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  return (
    <div className="border-border/30 border-t bg-white/20 px-3 py-2 md:px-4 md:py-3 dark:bg-white/[0.02]">
      <div className="px-1 sm:px-2 md:px-4">
        {/* Image preview strip */}
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((img, index) => (
              <div key={index} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- local object URLs for preview */}
                <img
                  src={img.previewUrl}
                  alt={img.file.name}
                  className="ring-border/50 h-16 w-16 rounded-lg object-cover ring-1"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  onClick={() => removeImage(index)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 opacity-70 transition-opacity group-hover:opacity-100"
                  aria-label={`Remove ${img.file.name}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="liquid-glass-inner relative flex items-center gap-2 rounded-2xl border-0 p-2">
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
                  {(Object.keys(TOOL_LABELS) as Array<keyof ToolConfig>).map((key) => (
                    <DropdownMenuCheckboxItem
                      key={key}
                      checked={!!toolConfig[key]}
                      onCheckedChange={() => onToggleTool(key)}
                    >
                      {TOOL_LABELS[key]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* File upload button */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
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
            onPaste={handlePaste}
            placeholder="Message Saale..."
            className={cn(
              "max-h-[200px] min-h-[40px] flex-1 resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0",
              "placeholder:text-muted-foreground",
            )}
            rows={1}
            disabled={isLoading}
          />

          {/* Send / Stop button */}
          {isLoading ? (
            <Button
              variant="secondary"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-full"
              onClick={onStop}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </Button>
          ) : (
            <Button
              className="liquid-glass-accent h-9 w-9 shrink-0 rounded-full transition-opacity disabled:opacity-50"
              size="icon"
              onClick={handleSubmit}
              disabled={!canSend}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
