"use client";

import { useState } from "react";
import { JobList } from "@/components/tasks/job-list";
import { JobDialog } from "@/components/tasks/job-dialog";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function TasksPage() {
  const [showJobDialog, setShowJobDialog] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            Tasks
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Automated AI tasks
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => setShowJobDialog(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Task
        </Button>
      </div>

      {/* Job list */}
      <JobList />

      {/* Dialog */}
      <JobDialog
        open={showJobDialog}
        onOpenChange={setShowJobDialog}
        onSuccess={() => {}}
      />
    </div>
  );
}
