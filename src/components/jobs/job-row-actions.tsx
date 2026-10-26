"use client";

import { Loader2, Lock, Pencil, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface JobRowActionsProps {
  /** A run of this job is in flight, whether this list started it or not. */
  running: boolean;
  /** This list sent the run request and is waiting for it. */
  pendingRun?: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Present together when the row can be switched on and off from here. */
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  /** Saale owns this job's configuration, so the row shows a lock instead. */
  locked?: boolean;
}

/** The run, switch, edit and delete controls at the end of a job row. */
export function JobRowActions({
  running,
  pendingRun = false,
  onRun,
  onEdit,
  onDelete,
  enabled,
  onToggle,
  locked = false,
}: JobRowActionsProps) {
  if (locked) {
    return (
      <Lock
        className="text-muted-foreground/60 mx-1 h-3.5 w-3.5"
        aria-label="Managed by Saale. locked"
      />
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {running ? (
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
          <Loader2 className="h-3 w-3 animate-spin" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRun}
          disabled={pendingRun}
        >
          {pendingRun ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </Button>
      )}
      {onToggle && (
        <Switch
          checked={enabled ?? false}
          onCheckedChange={onToggle}
          className="scale-75"
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
        <Pencil className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDelete}>
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
