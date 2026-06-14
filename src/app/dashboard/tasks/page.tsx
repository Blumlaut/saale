"use client";

import { useState, useCallback, useEffect } from "react";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { TaskList } from "@/components/tasks/task-list";
import { TaskForm } from "@/components/tasks/task-form";

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

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const data = await fetchJson<{ tasks: Task[] }>("/api/tasks?limit=200");
      setTasks(data.tasks);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handleToggleComplete = useCallback(async (task: Task) => {
    const newStatus = task.status === "completed" ? "pending" : "completed";
    try {
      await patchJson(`/api/tasks/${task.id}`, { status: newStatus });
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                status: newStatus,
                completedAt: newStatus === "completed" ? new Date().toISOString() : null,
              }
            : t,
        ),
      );
    } catch (err) {
      console.error("Failed to toggle task:", err);
    }
  }, []);

  const handleDelete = useCallback(async (taskId: string) => {
    try {
      await deleteJson(`/api/tasks/${taskId}`);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  }, []);

  const handleFormSubmit = useCallback(
    async (data: {
      title: string;
      description?: string;
      priority?: string;
      dueDate?: string;
      tags?: string[];
    }) => {
      try {
        if (editingTask) {
          await patchJson(`/api/tasks/${editingTask.id}`, data);
        } else {
          await postJson("/api/tasks", data);
        }
        setShowForm(false);
        setEditingTask(null);
        await loadTasks();
      } catch (err) {
        console.error("Failed to save task:", err);
      }
    },
    [editingTask, loadTasks],
  );

  const handleEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setShowForm(true);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setShowForm(open);
    if (!open) setEditingTask(null);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Tasks</h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">
            Action items and reminders
          </p>
        </div>
        <Button
          variant="default"
          size="icon"
          className="h-8 w-8 md:h-9 md:w-auto md:px-3"
          onClick={() => setShowForm(true)}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">New Task</span>
        </Button>
      </div>

      {/* Task list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground text-sm">Loading tasks...</div>
        </div>
      ) : (
        <TaskList
          tasks={tasks}
          onToggle={handleToggleComplete}
          onDelete={handleDelete}
          onEdit={handleEdit}
        />
      )}

      {/* Form dialog */}
      <TaskForm
        open={showForm}
        onOpenChange={handleFormClose}
        onSubmit={handleFormSubmit}
        task={editingTask}
      />
    </div>
  );
}
