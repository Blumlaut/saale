"use client";

import { useState, useCallback, useEffect } from "react";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { Page, PageHeader, PageScroll } from "@/components/layout/page";
import { TaskList } from "@/components/tasks/task-list";
import { TaskForm } from "@/components/tasks/task-form";
import { TaskChatDialog } from "@/components/tasks/task-chat-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Task } from "@/types/shared";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [chatTask, setChatTask] = useState<Task | null>(null);

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

  const handleDelete = useCallback(async () => {
    if (!deleteTask) return;
    try {
      await deleteJson(`/api/tasks/${deleteTask.id}`);
      setTasks((prev) => prev.filter((t) => t.id !== deleteTask.id));
      setDeleteTask(null);
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  }, [deleteTask]);

  const handleDeleteRequest = useCallback((task: Task) => {
    setDeleteTask(task);
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

  const handleChat = useCallback((task: Task) => {
    setChatTask(task);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setShowForm(open);
    if (!open) setEditingTask(null);
  }, []);

  return (
    <Page>
      {/* Header — pinned, never scrolls */}
      <PageHeader
        title="Tasks"
        description="Action items and reminders"
        actions={
          <Button
            variant="default"
            size="icon"
            className="h-8 w-8 md:h-9 md:w-auto md:px-3"
            onClick={() => setShowForm(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">New Task</span>
          </Button>
        }
      />

      {/* Task list — scrolls internally */}
      <PageScroll>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-muted-foreground text-sm">Loading tasks...</div>
          </div>
        ) : (
          <TaskList
            tasks={tasks}
            onToggle={handleToggleComplete}
            onDelete={handleDeleteRequest}
            onEdit={handleEdit}
            onChat={handleChat}
          />
        )}
      </PageScroll>

      {/* Form dialog */}
      <TaskForm
        open={showForm}
        onOpenChange={handleFormClose}
        onSubmit={handleFormSubmit}
        task={editingTask}
      />

      {/* Chat dialog */}
      <TaskChatDialog
        open={!!chatTask}
        onOpenChange={(open) => !open && setChatTask(null)}
        task={chatTask}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTask} onOpenChange={(open) => !open && setDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTask?.title}&quot;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} variant="destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
