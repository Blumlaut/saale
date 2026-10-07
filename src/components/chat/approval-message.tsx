"use client";

import { useEffect, useState } from "react";
import { Shield, Check, X, Loader2, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeValue, describeToolAction, findToolInfo } from "@/lib/pi/tool-infos";
import { getToolCategory } from "@/lib/pi/tool-categories";
import { formatToolArgs } from "./tool-args";
import type { ApprovalBatchData, ApprovalData } from "./types";

interface ApprovalMessageProps {
  sessionId: string;
  approval: ApprovalData;
  onResolved: (toolCallId: string) => void;
}

export function ApprovalMessage({ sessionId, approval, onResolved }: ApprovalMessageProps) {
  const [status, setStatus] = useState<"pending" | "approving" | "denying" | "done">("pending");
  const [expanded, setExpanded] = useState(true);
  const [showRawArgs, setShowRawArgs] = useState(false);
  // The card's own decision: the resolved badge must show what the user just
  // clicked, not the (possibly stale) prop — the parent removes the card
  // shortly after, but for a beat the badge is visible.
  const [decision, setDecision] = useState<boolean | null>(null);

  // Sync with external resolved state (e.g., after DB reload)
  useEffect(() => {
    if (approval.resolved) {
      setStatus("done");
    }
  }, [approval.resolved]);

  const handleAction = async (approved: boolean) => {
    setStatus(approved ? "approving" : "denying");
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/approve-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: approval.toolCallId,
          approved,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Approval failed:", err);
        // Already resolved elsewhere (another tab, Telegram, timeout) — the
        // card is stale and can never be approved again; dismiss it so the
        // user isn't stuck with an unapprovable approval.
        setStatus("done");
        onResolved(approval.toolCallId);
        return;
      }

      setStatus("done");
      setDecision(approved);
      onResolved(approval.toolCallId);
    } catch (err) {
      console.error("Failed to submit approval:", err);
      setStatus("pending");
    }
  };

  const approved = decision ?? approval.approved;

  const action = describeToolAction(approval.toolName, approval.args);
  // Category icon for the header; Wrench for tools outside the catalog.
  const info = findToolInfo(approval.toolName);
  const Icon = getToolCategory(info?.category ?? "")?.icon ?? Wrench;

  // What the call is about: the server-resolved summary (ID references
  // looked up against the user's records), then the argument-derived
  // summary, then the catalog description.
  const headline = approval.summary || action.summary || action.description || null;

  // Resolved state — compact single line
  if (status === "done") {
    return (
      <div className="liquid-glass-inner rounded-xl px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <Shield className="text-muted-foreground h-3 w-3" />
          <span className="font-medium">{action.label}</span>
          <Badge
            variant="secondary"
            className={
              approved
                ? "ml-auto rounded-full bg-green-500/10 px-1.5 py-0 text-[10px] text-green-600"
                : "ml-auto rounded-full bg-red-500/10 px-1.5 py-0 text-[10px] text-red-600"
            }
          >
            {approved ? <Check className="mr-1 h-2.5 w-2.5" /> : <X className="mr-1 h-2.5 w-2.5" />}
            {approved ? "Approved" : "Denied"}
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div className="liquid-glass-inner rounded-xl">
      {/* Header — toggle expand/collapse */}
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-3 w-3 shrink-0" />
        )}
        <Icon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 text-xs font-medium break-words">{action.label}</span>
        <Badge
          variant="secondary"
          className="ml-auto shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-600"
        >
          <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
          Awaiting approval
        </Badge>
      </button>

      {/* Expanded: what it does, how, and the decision */}
      {expanded && (
        <div className="border-border/30 border-t">
          {headline && <div className="px-3 pt-2 text-sm leading-snug">{headline}</div>}

          {/* What the one click covers, before how it does it */}
          {approval.batch && <BatchList batch={approval.batch} />}

          {action.fields.length > 0 && (
            <div className="space-y-1.5 px-3 py-2">
              {action.fields.map((field) => (
                <ActionField key={field.key} label={field.label} value={field.value} />
              ))}
            </div>
          )}

          {/* Raw arguments — full transparency, collapsed by default */}
          <div className="border-border/30 border-t">
            <button
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
              onClick={() => setShowRawArgs(!showRawArgs)}
            >
              {showRawArgs ? (
                <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="text-muted-foreground h-3 w-3 shrink-0" />
              )}
              <span className="text-muted-foreground text-[11px] font-medium">Raw arguments</span>
            </button>
            {showRawArgs && (
              <div className="px-3 pb-2">
                <pre className="bg-muted max-h-64 overflow-y-auto rounded-lg p-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {formatToolArgs(approval.args) || "{}"}
                </pre>
              </div>
            )}
          </div>

          <div className="border-border/30 border-t px-3 py-2">
            <div className="flex gap-2">
              <Button
                size="sm"
                className="liquid-glass-accent flex-1 gap-1.5"
                onClick={() => handleAction(true)}
                disabled={status !== "pending"}
              >
                {status === "approving" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive flex-1 gap-1.5"
                onClick={() => handleAction(false)}
                disabled={status !== "pending"}
              >
                {status === "denying" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Deny
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The calls an approval stands in for.
 *
 * A script's approval covers the calls it announced, so the card has to name
 * them: the user is approving those calls, not the script's text. Calls the
 * script makes that are not listed still ask for themselves, which is what the
 * note below says when the script can pick tools by name.
 */
function BatchList({ batch }: { batch: ApprovalBatchData }) {
  const labels = batch.tools.map((name) => findToolInfo(name)?.label ?? name);

  return (
    <div className="space-y-1.5 px-3 pt-2">
      <div className="text-muted-foreground text-[11px] font-medium">
        {labels.length === 1
          ? "One approval covers this call:"
          : `One approval covers these ${labels.length} calls:`}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {batch.tools.map((name, index) => (
          <Badge key={name} variant="secondary" className="rounded-full px-1.5 py-0 text-[10px]">
            {labels[index]}
          </Badge>
        ))}
      </div>
      {batch.dynamic && (
        <p className="text-muted-foreground text-[11px]">
          The script can also pick tools by name while it runs — those ask on their own.
        </p>
      )}
    </div>
  );
}

/**
 * One labeled argument: inline for short scalars, a clipped code block for
 * long/multi-line values (bodies, commands, scripts) with a show-more toggle.
 */
function ActionField({ label, value }: { label: string; value: unknown }) {
  const inline = toInlineValue(value);
  if (inline === null) return null; // nothing to show (empty, null, …)

  if (typeof inline === "string" && (inline.includes("\n") || inline.length > 120)) {
    return (
      <div className="space-y-1">
        <div className="text-muted-foreground text-[11px] font-medium">{label}</div>
        <CodeBlock text={inline} />
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted-foreground shrink-0 font-medium">{label}:</span>
      <span className="min-w-0 break-words">{inline}</span>
    </div>
  );
}

/**
 * Reduce a value to an inline string, or null when it needs a code block:
 * null/undefined and empty collections are hidden entirely, dates are
 * humanized, lists of scalars are joined.
 */
function toInlineValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value === "") return null;
    return formatDateTimeValue(value) ?? value;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return value
        .map((v) => (typeof v === "string" ? (formatDateTimeValue(v) ?? v) : v))
        .join(", ");
    }
    return null; // array of objects → code block
  }
  return null; // object → code block
}

/**
 * Clipped code block: shows the first few lines (or a length cap) with a
 * show-more toggle. Wraps instead of scrolling horizontally — the overlay
 * must never scroll sideways, even at 320px.
 */
function CodeBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  const lines = text.split("\n");
  const tooManyLines = lines.length > 6;
  const tooLong = text.length > 400;
  const clipped = tooManyLines || tooLong;

  let shown = text;
  if (!expanded && clipped) {
    shown = tooManyLines ? lines.slice(0, 6).join("\n") : text.slice(0, 400);
  }

  return (
    <div className="space-y-1">
      <pre className="bg-muted max-h-64 overflow-y-auto rounded-lg p-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
        {shown}
      </pre>
      {clipped && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}
