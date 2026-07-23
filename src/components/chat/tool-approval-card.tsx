"use client";

import { useEffect, useState, useCallback } from "react";
import { Shield, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";

interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expiresAt: string;
}

interface ToolApprovalCardProps {
  sessionId: string;
  request: ApprovalRequest;
  onResolved: (toolCallId: string) => void;
}

export function ToolApprovalCard({ sessionId, request, onResolved }: ToolApprovalCardProps) {
  const [status, setStatus] = useState<"pending" | "approving" | "denying" | "done">("pending");
  const [timeLeft, setTimeLeft] = useState("");

  const updateTimer = useCallback(() => {
    const expires = new Date(request.expiresAt);
    const diff = expires.getTime() - Date.now();
    if (diff <= 0) {
      setTimeLeft("expired");
      return;
    }
    setTimeLeft(formatDistanceToNow(expires, { addSuffix: true }));
  }, [request.expiresAt]);

  useEffect(() => {
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [updateTimer]);

  const handleAction = async (approved: boolean) => {
    setStatus(approved ? "approving" : "denying");
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/approve-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: request.toolCallId,
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
      onResolved(request.toolCallId);
    } catch (err) {
      console.error("Failed to submit approval:", err);
      setStatus("pending");
    }
  };

  const argsPreview = Object.entries(request.args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .slice(0, 3)
    .join("\n");

  return (
    <div className="mx-auto my-2 max-w-md rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Shield className="h-5 w-5 text-yellow-400" />
        <span className="font-medium text-yellow-200">Tool Approval Required</span>
      </div>

      <div className="mb-3 rounded bg-black/20 p-2 font-mono text-sm">
        <div className="mb-1 font-semibold text-yellow-100">{request.toolName}</div>
        {argsPreview && (
          <pre className="text-xs whitespace-pre-wrap text-yellow-200/70">{argsPreview}</pre>
        )}
      </div>

      <div className="mb-3 flex items-center justify-between text-xs text-yellow-200/50">
        <span>Expires {timeLeft}</span>
        {status === "done" && <span>Resolved</span>}
      </div>

      <div className="flex gap-2">
        {status === "pending" ? (
          <>
            <Button
              size="sm"
              className="flex-1 gap-1 bg-green-600 text-green-50 hover:bg-green-500"
              onClick={() => handleAction(true)}
            >
              <Check className="h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-1 border-red-500/30 text-red-300 hover:bg-red-500/20 hover:text-red-200"
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
  );
}
