"use client";

import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Page, PageAction, PageScroll } from "@/components/layout/page";
import { JobList } from "@/components/jobs/job-list";
import { JobDialog } from "@/components/jobs/job-dialog";
import { WatcherList } from "@/components/jobs/watcher-list";
import { WatcherDialog } from "@/components/jobs/watcher-dialog";
import type { ScriptWatcher } from "@/types/shared";

export type JobsSection = "automations" | "scheduled";

/** One page of the Jobs area. The kind is the route, not a tab. */
export function JobsArea({ section }: { section: JobsSection }) {
  // Scheduled (built-in) job state
  const [showJobDialog, setShowJobDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<{
    id: string;
    type: string;
    enabled: boolean;
    modelId: string | null;
    config: Record<string, unknown>;
  } | null>(null);
  const [jobRefreshKey, setJobRefreshKey] = useState(0);

  // Automation state
  const [showAutomationDialog, setShowAutomationDialog] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<ScriptWatcher | null>(null);
  const [automationRefreshKey, setAutomationRefreshKey] = useState(0);

  const handleJobCreated = useCallback(() => {
    setJobRefreshKey((k) => k + 1);
  }, []);

  const handleJobEdit = useCallback(
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

  const handleJobDialogClose = useCallback((open: boolean) => {
    setShowJobDialog(open);
    if (!open) setEditingJob(null);
  }, []);

  const handleAutomationCreated = useCallback(() => {
    setAutomationRefreshKey((k) => k + 1);
  }, []);

  const handleAutomationEdit = useCallback((automation: ScriptWatcher) => {
    setEditingAutomation(automation);
    setShowAutomationDialog(true);
  }, []);

  const handleAutomationDialogClose = useCallback((open: boolean) => {
    setShowAutomationDialog(open);
    if (!open) setEditingAutomation(null);
  }, []);

  return (
    <Page>
      {section === "scheduled" && (
        <PageScroll>
          <JobList
            key={jobRefreshKey}
            onEdit={handleJobEdit}
            onRefresh={handleJobCreated}
            action={
              <PageAction icon={Plus} label="New job" onClick={() => setShowJobDialog(true)} />
            }
          />
        </PageScroll>
      )}

      {section === "automations" && (
        <PageScroll>
          <WatcherList
            key={automationRefreshKey}
            onEdit={handleAutomationEdit}
            onRefresh={handleAutomationCreated}
            action={
              <PageAction
                icon={Plus}
                label="New automation"
                onClick={() => setShowAutomationDialog(true)}
              />
            }
          />
        </PageScroll>
      )}

      <JobDialog
        open={showJobDialog}
        onOpenChange={handleJobDialogClose}
        onSuccess={handleJobCreated}
        job={editingJob}
      />

      <WatcherDialog
        open={showAutomationDialog}
        onOpenChange={handleAutomationDialogClose}
        onSuccess={handleAutomationCreated}
        watcher={editingAutomation}
      />
    </Page>
  );
}
