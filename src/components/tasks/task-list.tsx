"use client";

import { useMemo, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { TaskItem } from "./task-item";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  tags: string[];
  order: number;
  source: string;
  sourceEmailId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskListProps {
  tasks: Task[];
  onToggle: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onEdit: (task: Task) => void;
}

type GroupKey = "overdue" | "today" | "thisWeek" | "someday" | "completed";

export function TaskList({ tasks, onToggle, onDelete, onEdit }: TaskListProps) {
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

  if (tasks.length === 0) {
    return (
      <GlassPanel>
        <GlassPanelContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="text-muted-foreground text-sm">No tasks yet</div>
          <div className="text-muted-foreground/60 mt-1 text-xs">
            Create one manually or ask the AI to add tasks from chat or email
          </div>
        </GlassPanelContent>
      </GlassPanel>
    );
  }

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
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.key);
        return (
          <GlassPanel key={group.key}>
            {group.collapsible && (
              <div
                className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-white/10"
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
              <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
                {group.label}
                <span className="text-muted-foreground text-xs">({group.tasks.length})</span>
              </div>
            )}

            {!isCollapsed && (
              <GlassPanelContent className="p-0">
                {group.tasks.map((task, i) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    isLast={i === group.tasks.length - 1}
                    onToggle={onToggle}
                    onDelete={onDelete}
                    onEdit={onEdit}
                    groupKey={group.key}
                  />
                ))}
              </GlassPanelContent>
            )}
          </GlassPanel>
        );
      })}
    </div>
  );
}
