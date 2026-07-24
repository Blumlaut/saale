"use client";

import { useEffect, useState } from "react";
import { Shield, Check, X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ApprovalData } from "./types";

interface ApprovalMessageProps {
  sessionId: string;
  approval: ApprovalData;
  onResolved: (toolCallId: string) => void;
}

export function ApprovalMessage({ sessionId, approval, onResolved }: ApprovalMessageProps) {
  const [status, setStatus] = useState<"pending" | "approving" | "denying" | "done">("pending");
  const [expanded, setExpanded] = useState(true);

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
        setStatus("pending");
        return;
      }

      setStatus("done");
      onResolved(approval.toolCallId);
    } catch (err) {
      console.error("Failed to submit approval:", err);
      setStatus("pending");
    }
  };

  const argsPreview = Object.entries(approval.args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .slice(0, 3)
    .join("\n");

  // Resolved state — compact single line
  if (status === "done") {
    return (
      <div className="liquid-glass-inner rounded-xl px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <Shield className="text-muted-foreground h-3 w-3" />
          <span className="font-medium">{approval.toolName}</span>
          <Badge
            variant="secondary"
            className={
              approval.approved
                ? "ml-auto rounded-full bg-green-500/10 px-1.5 py-0 text-[10px] text-green-600"
                : "ml-auto rounded-full bg-red-500/10 px-1.5 py-0 text-[10px] text-red-600"
            }
          >
            {approval.approved ? (
              <Check className="mr-1 h-2.5 w-2.5" />
            ) : (
              <X className="mr-1 h-2.5 w-2.5" />
            )}
            {approval.approved ? "Approved" : "Denied"}
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
          <ChevronDown className="text-muted-foreground h-3 w-3" />
        ) : (
          <ChevronRight className="text-muted-foreground h-3 w-3" />
        )}
        <Shield className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">{approval.toolName}</span>
        <Badge
          variant="secondary"
          className="ml-auto rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-600"
        >
          <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
          Awaiting approval
        </Badge>
      </button>

      {/* Expanded: args + actions */}
      {expanded && (
        <div className="border-border/30 border-t">
          {argsPreview && (
            <div className="px-3 py-2">
              <pre className="rounded-lg bg-white/10 p-2 text-xs leading-relaxed whitespace-pre-wrap dark:bg-white/5">
                {argsPreview}
              </pre>
            </div>
          )}

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
