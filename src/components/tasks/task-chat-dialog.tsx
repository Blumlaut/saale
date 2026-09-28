"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MessageSquare } from "lucide-react";
import { startTaskChat } from "@/lib/chat/task-chat";
import type { Task } from "@/types/shared";

interface TaskChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
}

export function TaskChatDialog({ open, onOpenChange, task }: TaskChatDialogProps) {
  const router = useRouter();
  const [context, setContext] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setContext("");
      setError(null);
      setStarting(false);
    }
  }, [open, task]);

  if (!task) return null;

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const { sessionId } = await startTaskChat(task, context);
      onOpenChange(false);
      router.push(`/dashboard/chat/${sessionId}`);
    } catch (err) {
      console.error("Failed to start task chat:", err);
      setError("Could not start the chat. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Chat about task</DialogTitle>
          <DialogDescription>
            The agent gets &quot;{task.title}&quot; plus the context you add below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="task-chat-context">
            Additional context <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Textarea
            id="task-chat-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Anything the agent should keep in mind while working the task..."
            rows={4}
            autoFocus
          />
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={starting}>
            {starting ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="mr-2 h-3.5 w-3.5" />
            )}
            Start chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
