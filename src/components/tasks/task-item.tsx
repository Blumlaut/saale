"use client";

import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Mail, MessageSquare, Trash2, Pencil } from "lucide-react";
import { format } from "date-fns";
import type { Task } from "@/types/shared";

interface TaskItemProps {
  task: Task;
  isLast: boolean;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onEdit: (task: Task) => void;
  onChat: (task: Task) => void;
  groupKey: string;
}

const priorityConfig = {
  high: { dot: "bg-red-400", label: "High" },
  medium: { dot: "bg-amber-400", label: "Medium" },
  low: { dot: "bg-gray-400", label: "Low" },
};

const sourceConfig: Record<string, { icon: typeof Mail; label: string }> = {
  email_extraction: { icon: Mail, label: "Email" },
  chat: { icon: MessageSquare, label: "Chat" },
};

export function TaskItem({
  task,
  isLast,
  onToggle,
  onDelete,
  onEdit,
  onChat,
  groupKey,
}: TaskItemProps) {
  const dueDateLabel = task.dueDate ? format(new Date(task.dueDate), "EEE MMM d") : null;

  const isCompleted = task.status === "completed";
  const priority = priorityConfig[task.priority as keyof typeof priorityConfig];
  const source = sourceConfig[task.source];

  return (
    <>
      <div
        className={cn(
          "group hover:bg-accent/60 flex items-center gap-3 px-4 py-2.5 transition-colors",
          isCompleted && "opacity-60",
        )}
      >
        {/* Checkbox */}
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => onToggle(task)}
          className="h-4 w-4"
        />

        {/* Title + details */}
        <div className="min-h-0 min-w-0 flex-1">
          <div className={cn("truncate text-sm font-medium", isCompleted && "line-through")}>
            {task.title}
          </div>
          {task.description && (
            <div className="text-muted-foreground truncate text-xs">{task.description}</div>
          )}
        </div>

        {/* Meta badges */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Priority dot */}
          <div className={cn("h-2 w-2 rounded-full", priority.dot)} title={priority.label} />

          {/* Due date */}
          {dueDateLabel && (
            <span
              className={cn(
                "text-xs",
                groupKey === "overdue"
                  ? "text-red-400"
                  : groupKey === "today"
                    ? "text-blue-400"
                    : "text-muted-foreground",
              )}
            >
              {dueDateLabel}
            </span>
          )}

          {/* Source badge */}
          {source && (
            <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">
              <source.icon className="mr-0.5 h-3 w-3" />
              {source.label}
            </Badge>
          )}

          {/* Tags */}
          {task.tags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="h-5 rounded-full px-1.5 text-[10px]">
              {tag}
            </Badge>
          ))}
          {task.tags.length > 2 && (
            <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]">
              +{task.tags.length - 2}
            </Badge>
          )}

          {/* Actions menu */}
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="text-muted-foreground hover:bg-accent/60 inline-flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem onClick={() => onChat(task)}>
                <MessageSquare className="mr-2 h-3.5 w-3.5" />
                Chat
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(task)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(task)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!isLast && <Separator className="px-4" />}
    </>
  );
}
