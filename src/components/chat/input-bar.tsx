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
import { Paperclip, Send, Loader2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ToolConfig {
  bash: boolean;
  files: boolean;
  email: boolean;
  jobs: boolean;
  calendar: boolean;
  chatSearch: boolean;
  web: boolean;
}

interface InputBarProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  onStop: () => void;
  onFileUpload?: (file: File) => void;
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

export function InputBar({
  onSend,
  isLoading,
  onStop,
  onFileUpload,
  toolConfig,
  onToggleTool,
}: InputBarProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasToolToggle = onToggleTool !== undefined && toolConfig !== undefined;

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;
    onSend(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isLoading, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onFileUpload) {
      onFileUpload(file);
    }
    if (e.target) e.target.value = "";
  };

  const autoResize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  return (
    <div className="border-border/30 border-t bg-white/20 px-3 py-2 md:px-4 md:py-3 dark:bg-white/[0.02]">
      <div className="px-1 sm:px-2 md:px-4">
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
          {onFileUpload && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          )}
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />

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
              disabled={!input.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mt-2 text-center text-xs">
          Saale can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
