"use client";

import { AlertCircle, Ban, CheckCircle, Clock, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/** How a job run ended, as the badge every job list shows. */
export function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Completed
        </Badge>
      );
    case "error":
      return (
        <Badge variant="secondary" className="bg-destructive/10 text-destructive">
          <AlertCircle className="mr-1 h-3 w-3" />
          Error
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="secondary" className="bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">
          <Ban className="mr-1 h-3 w-3" />
          Cancelled
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Running
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Clock className="mr-1 h-3 w-3" />
          Pending
        </Badge>
      );
  }
}
