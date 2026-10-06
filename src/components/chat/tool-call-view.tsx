"use client";

import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { Wrench, ChevronDown, ChevronRight } from "lucide-react";
import { FileCard } from "./file-card";
import { RedactedToolCall } from "./redacted-tool-call";
import { WebSearchCard, WebFetchCard } from "./web-tool-cards";
import { MailToolCard } from "./mail-tool-cards";
import { CalendarToolCard } from "./calendar-tool-cards";
import { InfraToolCard } from "./infra-tool-cards";
import { CodemodeToolCard } from "./codemode-tool-card";
import { ToolStatusBadge } from "./tool-status-badge";
import { formatToolArgs } from "./tool-args";
import type { ToolCallData } from "./types";

/**
 * Renders a tool call with the dedicated card for known tools, falling back
 * to a generic accordion for everything else.
 *
 * The owner's path: `MessageList` is the only caller. The share viewer renders
 * `RedactedToolCall` directly, so a card added below can never reach a public
 * page — `__tests__/share-redaction-coverage.test.ts` enforces that.
 *
 * The `redacted` check is a second line of defence for any other caller handed
 * a share payload: it fires before a card below can read `args` or `result`
 * (and before `ShowFileCard` can fetch a file).
 */
export const ToolCallView = memo(function ToolCallView({ toolCall }: { toolCall: ToolCallData }) {
  if (toolCall.redacted) return <RedactedToolCall toolCall={toolCall} />;

  return toolCall.name === "show_file" ? (
    <ShowFileCard toolCall={toolCall} />
  ) : toolCall.name === "codemode" ? (
    <CodemodeToolCard toolCall={toolCall} />
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
});

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
        <ToolStatusBadge toolCall={toolCall} />
      </button>

      {expanded && (
        <div className="border-border/30 border-t px-3 py-2">
          <div className="space-y-1">
            <div className="text-muted-foreground text-xs">
              <span className="font-medium">Arguments:</span>
            </div>
            <pre className="bg-muted overflow-x-auto rounded-lg p-2 text-xs break-words whitespace-pre-wrap">
              {formatToolArgs(toolCall.args)}
            </pre>
            {toolCall.result && (
              <>
                <div className="text-muted-foreground text-xs">
                  <span className="font-medium">{toolCall.error ? "Error:" : "Result:"}</span>
                </div>
                <pre
                  className={cn(
                    "overflow-x-auto rounded-lg p-2 text-xs break-words whitespace-pre-wrap",
                    toolCall.error ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted",
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
