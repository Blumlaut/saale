"use client";

import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { ToolCallView } from "@/components/chat/tool-call-view";
import type { ToolCallData } from "@/components/chat/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CouncilMessageView, CouncilToolCall, CouncilTurnView } from "@/types/council";
import { AlertCircle, ArrowDownToLine, CheckCircle2, MessagesSquare, Send } from "lucide-react";

/** Map a member's stored tool call onto the chat card renderer's shape. */
function toToolCallData(call: CouncilToolCall): ToolCallData {
  return {
    id: call.id,
    name: call.name,
    args: call.args,
    status: call.isError ? "error" : "completed",
    result: call.result,
    error: call.isError ? (call.result ?? "The tool failed.") : undefined,
  };
}

function ToolCallCard({ call }: { call: CouncilToolCall }) {
  return <ToolCallView toolCall={toToolCallData(call)} />;
}

function labelForSeq(seq: number, bySeq: Map<number, CouncilMessageView>): string {
  const message = bySeq.get(seq);
  if (!message) return `#${seq}`;
  return `#${seq} · ${message.authorName}`;
}

function excerpt(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

export interface AgentTranscriptProps {
  turns: CouncilTurnView[];
  /** The room's messages, used to label the seqs a turn was woken by. */
  messages?: CouncilMessageView[];
  loading?: boolean;
}

/**
 * One member's private transcript: every turn it took.
 *
 * A turn shows what woke it (the room messages it had not seen), its reasoning,
 * each tool call it made, and the closing text it produced — which was **not
 * sent** to the room. Members speak only through `council_post`, so this is the
 * only place that closing text is visible.
 */
export function AgentTranscript({ turns, messages = [], loading }: AgentTranscriptProps) {
  const bySeq = new Map(messages.map((message) => [message.seq, message]));

  if (loading && turns.length === 0) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
        <MessagesSquare className="text-muted-foreground h-5 w-5" />
        <p className="text-muted-foreground text-sm">No turns recorded.</p>
        <p className="text-muted-foreground max-w-sm text-xs">
          This member has not been woken in the selected run.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {turns.map((turn, index) => {
        const statusTone =
          turn.status === "error"
            ? "bg-destructive/10 text-destructive"
            : turn.status === "running"
              ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : "bg-green-500/10 text-green-600 dark:text-green-400";

        return (
          <article key={turn.id} className="liquid-glass-inner rounded-xl border-0 p-3 md:p-4">
            <header className="flex flex-wrap items-center gap-2">
              <span className="console-label">Turn {turns.length - index}</span>
              <Badge variant="secondary" className={cn(statusTone)}>
                {turn.status === "error" ? (
                  <AlertCircle className="mr-1 h-3 w-3" />
                ) : (
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                )}
                {turn.status}
              </Badge>
              {turn.startedAt && (
                <span className="text-muted-foreground text-xs">
                  {formatRelativeDate(turn.startedAt)}
                </span>
              )}
              <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                {turn.inputTokens + turn.outputTokens} tok · ${turn.cost.toFixed(4)}
              </span>
            </header>

            {turn.error && <p className="text-destructive mt-2 text-xs">{turn.error}</p>}

            <section className="mt-3">
              <div className="console-label flex items-center gap-1">
                <ArrowDownToLine className="h-3 w-3" />
                Woken by
              </div>
              {turn.triggeredBy.length === 0 ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  No room message woke it: the opening turn, or its scheduled round.
                </p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {turn.triggeredBy.map((seq) => {
                    const message = bySeq.get(seq);
                    return (
                      <li key={seq} className="text-xs">
                        <span className="font-mono">{labelForSeq(seq, bySeq)}</span>
                        {message && (
                          <span className="text-muted-foreground">
                            {" "}
                            — {excerpt(message.content)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {turn.thinking && turn.thinking.trim() && (
              <section className="mt-3">
                <div className="console-label">Thinking</div>
                <p className="text-muted-foreground mt-1 max-h-64 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
                  {turn.thinking}
                </p>
              </section>
            )}

            {turn.toolCalls.length > 0 && (
              <section className="mt-3">
                <div className="console-label">Tool calls · {turn.toolCalls.length}</div>
                <div className="mt-1 flex flex-col gap-1.5">
                  {turn.toolCalls.map((call) => (
                    <ToolCallCard key={call.id} call={call} />
                  ))}
                </div>
              </section>
            )}

            {turn.finalText && turn.finalText.trim() && (
              <section className="mt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="console-label">Final text</span>
                  <Badge variant="outline" className="text-[10px]">
                    <Send className="mr-1 h-3 w-3" />
                    NOT sent to the room
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  This is what the member wrote to itself. Only a `council_post` call publishes to
                  the room.
                </p>
                <div className="border-border/50 mt-1.5 rounded-lg border border-dashed px-3 py-2">
                  <MarkdownRenderer content={turn.finalText} className="text-sm" />
                </div>
              </section>
            )}

            {turn.postedSeqs.length > 0 && (
              <p className="text-muted-foreground mt-3 text-[11px]">
                Posted to the room:{" "}
                <span className="font-mono">
                  {turn.postedSeqs.map((seq) => `#${seq}`).join(", ")}
                </span>
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
