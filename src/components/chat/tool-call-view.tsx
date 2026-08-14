"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Wrench, CheckCircle, AlertCircle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { FileCard } from "./file-card";
import { WebSearchCard, WebFetchCard } from "./web-tool-cards";
import { MailToolCard } from "./mail-tool-cards";
import { CalendarToolCard } from "./calendar-tool-cards";
import { InfraToolCard } from "./infra-tool-cards";
import type { ToolCallData } from "./types";

/**
 * Renders a tool call with the dedicated card for known tools, falling back
 * to a generic accordion for everything else.
 *
 * Shared by the interactive chat (MessageList) and the read-only share
 * viewer so both render tool calls identically.
 */
export function ToolCallView({ toolCall }: { toolCall: ToolCallData }) {
  return toolCall.name === "show_file" ? (
    <ShowFileCard toolCall={toolCall} />
  ) : toolCall.name === "web_search" ? (
    <WebSearchCard toolCall={toolCall} />
  ) : toolCall.name === "web_fetch" ? (
    <WebFetchCard toolCall={toolCall} />
  ) : toolCall.name === "mail_list" ||
    toolCall.name === "mail_search" ||
    toolCall.name === "mail_read" ? (
    <MailToolCard toolCall={toolCall} />
  ) : toolCall.name === "calendar_upcoming" || toolCall.name === "calendar_search" ? (
    <CalendarToolCard toolCall={toolCall} />
  ) : toolCall.name.startsWith("infra_") ? (
    <InfraToolCard toolCall={toolCall} />
  ) : (
    <GenericToolCall toolCall={toolCall} />
  );
}

/**
 * Renders a show_file tool call as a FileCard with preview and download.
 * Extracts file metadata from the tool call args.
 */
function ShowFileCard({ toolCall }: { toolCall: ToolCallData }) {
  const filePath = typeof toolCall.args.filePath === "string" ? toolCall.args.filePath : "";
  const fileName = pathBasename(filePath);
  const description =
    typeof toolCall.args.description === "string" ? toolCall.args.description : undefined;

  // Guess MIME from extension (client-side, matches server)
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeType = ext ? guessMimeType(ext) : undefined;

  const isError = toolCall.status === "error" || !!toolCall.error;

  return (
    <FileCard
      filePath={filePath}
      fileName={fileName}
      mimeType={mimeType}
      size={undefined}
      description={description}
      isError={isError}
      errorMessage={toolCall.error}
    />
  );
}

/** Simple path.basename polyfill (avoids importing 'path' in client code) */
function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Guess MIME type from file extension (client-side, matches server) */
function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    md: "text/markdown",
    yaml: "text/yaml",
    yml: "text/yaml",
    zip: "application/zip",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Generic tool call accordion for tools without a dedicated card.
 */
function GenericToolCall({ toolCall }: { toolCall: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-3 w-3" />
        ) : (
          <ChevronRight className="text-muted-foreground h-3 w-3" />
        )}
        <Wrench className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">{toolCall.name}</span>
        <Badge
          variant="secondary"
          className={cn(
            "ml-auto rounded-full px-1.5 py-0 text-[10px]",
            toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
            toolCall.status === "completed" && "bg-green-500/10 text-green-600",
            (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
          )}
        >
          {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
          {toolCall.status === "completed" && <CheckCircle className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {toolCall.status || (toolCall.error ? "error" : "done")}
        </Badge>
      </button>

      {expanded && (
        <div className="border-border/30 border-t px-3 py-2">
          <div className="space-y-1">
            <div className="text-muted-foreground text-xs">
              <span className="font-medium">Arguments:</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-white/10 p-2 text-xs dark:bg-white/5">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
            {toolCall.result && (
              <>
                <div className="text-muted-foreground text-xs">
                  <span className="font-medium">{toolCall.error ? "Error:" : "Result:"}</span>
                </div>
                <pre
                  className={cn(
                    "overflow-x-auto rounded-lg p-2 text-xs",
                    toolCall.error ? "bg-red-500/10 text-red-600" : "bg-white/10 dark:bg-white/5",
                  )}
                >
                  {toolCall.result.slice(0, 1000)}
                  {toolCall.result.length > 1000 && "..."}
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
