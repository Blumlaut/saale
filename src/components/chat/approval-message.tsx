"use client";

import { useEffect, useState, useCallback } from "react";
import { Shield, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import type { ApprovalData } from "./types";

interface ApprovalMessageProps {
  sessionId: string;
  approval: ApprovalData;
  onResolved: (toolCallId: string) => void;
}

export function ApprovalMessage({ sessionId, approval, onResolved }: ApprovalMessageProps) {
  const [status, setStatus] = useState<"pending" | "approving" | "denying" | "done">("pending");
  const [timeLeft, setTimeLeft] = useState("");

  const updateTimer = useCallback(() => {
    const expires = new Date(approval.expiresAt);
    const diff = expires.getTime() - Date.now();
    if (diff <= 0) {
      setTimeLeft("expired");
      return;
    }
    setTimeLeft(formatDistanceToNow(expires, { addSuffix: true }));
  }, [approval.expiresAt]);

  useEffect(() => {
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [updateTimer]);

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
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .slice(0, 3)
    .join("\n");

  // Resolved state
  if (status === "done") {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {approval.approved ? (
          <>
            <Check className="h-3.5 w-3.5 text-green-400" />
            <span>
              Approved <code className="text-foreground/80 font-medium">{approval.toolName}</code>
            </span>
          </>
        ) : (
          <>
            <X className="h-3.5 w-3.5 text-red-400" />
            <span>
              Denied <code className="text-foreground/80 font-medium">{approval.toolName}</code>
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="liquid-glass-inner rounded-xl border border-yellow-500/20">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Shield className="h-4 w-4 text-yellow-400" />
        <span className="text-sm font-medium text-yellow-200">Tool Approval Required</span>
        <span className="ml-auto text-xs text-yellow-200/50">Expires {timeLeft}</span>
      </div>

      {/* Tool details */}
      <div className="border-border/30 border-t px-3 py-2">
        <div className="mb-2 font-mono text-sm font-semibold text-yellow-100">
          {approval.toolName}
        </div>
        {argsPreview && (
          <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-yellow-200/70">
            {argsPreview}
          </pre>
        )}
      </div>

      {/* Actions */}
      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex gap-2">
          {status === "pending" ? (
            <>
              <Button
                size="sm"
                className="flex-1 gap-1.5 bg-green-600 text-green-50 hover:bg-green-500"
                onClick={() => handleAction(true)}
              >
                <Check className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 gap-1.5 border-red-500/30 text-red-300 hover:bg-red-500/20 hover:text-red-200"
                onClick={() => handleAction(false)}
              >
                <X className="h-3.5 w-3.5" />
                Deny
              </Button>
            </>
          ) : (
            <div className="flex w-full items-center justify-center gap-2 text-sm text-yellow-200/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              {status === "approving" ? "Approving..." : "Denying..."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
