"use client";

import { useMemo, useState } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { TaskItem } from "./task-item";
import { ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import type { Task } from "@/types/shared";

interface TaskListProps {
  tasks: Task[];
  loading?: boolean;
  onNew: () => void;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onEdit: (task: Task) => void;
  onChat: (task: Task) => void;
}

type GroupKey = "overdue" | "today" | "thisWeek" | "someday" | "completed";

export function TaskList({
  tasks,
  loading,
  onNew,
  onToggle,
  onDelete,
  onEdit,
  onChat,
}: TaskListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(new Set(["completed"]));

  const groups = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfWeek = new Date(startOfDay);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    const pending = tasks.filter((t) => t.status === "pending");
    const completed = tasks.filter((t) => t.status === "completed");

    const overdue: Task[] = [];
    const today: Task[] = [];
    const thisWeek: Task[] = [];
    const someday: Task[] = [];

    for (const task of pending) {
      if (!task.dueDate) {
        someday.push(task);
      } else {
        const due = new Date(task.dueDate);
        const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());

        if (dueDay < startOfDay) {
          overdue.push(task);
        } else if (dueDay.getTime() === startOfDay.getTime()) {
          today.push(task);
        } else if (dueDay < endOfWeek) {
          thisWeek.push(task);
        } else {
          someday.push(task);
        }
      }
    }

    // Sort within groups by order field
    const sortWithinGroup = (a: Task, b: Task) => a.order - b.order;
    overdue.sort(sortWithinGroup);
    today.sort(sortWithinGroup);
    thisWeek.sort(sortWithinGroup);
    someday.sort(sortWithinGroup);
    completed.sort((a, b) => {
      const aCompleted = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bCompleted = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bCompleted - aCompleted;
    });

    return [
      { key: "overdue" as const, label: "Overdue", tasks: overdue },
      { key: "today" as const, label: "Today", tasks: today },
      { key: "thisWeek" as const, label: "This Week", tasks: thisWeek },
      { key: "someday" as const, label: "Someday", tasks: someday },
      {
        key: "completed" as const,
        label: "Completed",
        tasks: completed,
        collapsible: true,
        defaultCollapsed: true,
      },
    ].filter((g) => g.tasks.length > 0);
  }, [tasks]);

  const toggleGroup = (key: GroupKey) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      {/* Toolbar — page actions, right-aligned; no page title */}
      <div className="border-border/30 flex shrink-0 items-center justify-end border-b px-4 py-2">
        <Button variant="default" size="icon" className="h-8 w-8 md:w-auto md:px-3" onClick={onNew}>
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">New Task</span>
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-12">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <div className="text-muted-foreground text-sm">No tasks yet</div>
          <div className="text-muted-foreground/60 mt-1 text-xs">
            Create one manually or ask the AI to add tasks from chat or email
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group, gi) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key} className={gi > 0 ? "border-border/30 border-t" : undefined}>
                {group.collapsible && (
                  <div
                    className="hover:bg-accent/60 flex cursor-pointer items-center gap-2 px-4 py-2 text-sm font-medium transition-colors"
                    onClick={() => toggleGroup(group.key)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="text-muted-foreground h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="text-muted-foreground h-3.5 w-3.5" />
                    )}
                    {group.label}
                    <span className="text-muted-foreground text-xs">({group.tasks.length})</span>
                  </div>
                )}

                {!group.collapsible && (
                  <div className="px-4 py-2 text-sm font-medium">
                    {group.label}
                    <span className="text-muted-foreground ml-1.5 text-xs">
                      ({group.tasks.length})
                    </span>
                  </div>
                )}

                {!isCollapsed && (
                  <div>
                    {group.tasks.map((task, i) => (
                      <TaskItem
                        key={task.id}
                        task={task}
                        isLast={i === group.tasks.length - 1}
                        onToggle={onToggle}
                        onDelete={onDelete}
                        onEdit={onEdit}
                        onChat={onChat}
                        groupKey={group.key}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </GlassPanel>
  );
}
