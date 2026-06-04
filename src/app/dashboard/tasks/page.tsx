"use client";

import { useState, useCallback } from "react";
import { JobList } from "@/components/tasks/job-list";
import { JobDialog } from "@/components/tasks/job-dialog";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function TasksPage() {
  const [showJobDialog, setShowJobDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<{
    id: string;
    type: string;
    enabled: boolean;
    modelId: string | null;
    config: Record<string, unknown>;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleJobCreated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleEdit = useCallback(
    (job: {
      id: string;
      type: string;
      enabled: boolean;
      modelId: string | null;
      config: Record<string, unknown>;
    }) => {
      setEditingJob(job);
      setShowJobDialog(true);
    },
    [],
  );

  const handleDialogClose = useCallback((open: boolean) => {
    setShowJobDialog(open);
    if (!open) {
      setEditingJob(null);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Tasks</h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">Automated AI tasks</p>
        </div>
        <Button
          variant="default"
          size="icon"
          className="h-8 w-8 md:h-9 md:w-auto md:px-3"
          onClick={() => setShowJobDialog(true)}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">New Task</span>
        </Button>
      </div>

      {/* Job list */}
      <JobList key={refreshKey} onEdit={handleEdit} />

      {/* Dialog */}
      <JobDialog
        open={showJobDialog}
        onOpenChange={handleDialogClose}
        onSuccess={handleJobCreated}
        job={editingJob}
      />
    </div>
  );
}
