"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { Page, PageScroll, PageToolbar } from "@/components/layout/page";
import { JobList } from "@/components/jobs/job-list";
import { JobDialog } from "@/components/jobs/job-dialog";
import { AgentJobList } from "@/components/jobs/agent-job-list";
import { AgentJobDialog } from "@/components/jobs/agent-job-dialog";
import { WatcherList } from "@/components/jobs/watcher-list";
import { WatcherDialog } from "@/components/jobs/watcher-dialog";
import type { AgentJobDefinition, ScriptWatcher } from "@/types/shared";

export type JobsSection = "agents" | "scheduled" | "watchers";

/** One page of the Jobs area. The kind is the route, not a tab. */
export function JobsArea({ section }: { section: JobsSection }) {
  // Agent job state
  const [showAgentDialog, setShowAgentDialog] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentJobDefinition | null>(null);
  const [agentRefreshKey, setAgentRefreshKey] = useState(0);

  // Legacy job state
  const [showJobDialog, setShowJobDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<{
    id: string;
    type: string;
    enabled: boolean;
    modelId: string | null;
    config: Record<string, unknown>;
  } | null>(null);
  const [jobRefreshKey, setJobRefreshKey] = useState(0);

  // Watcher state
  const [showWatcherDialog, setShowWatcherDialog] = useState(false);
  const [editingWatcher, setEditingWatcher] = useState<ScriptWatcher | null>(null);
  const [watcherRefreshKey, setWatcherRefreshKey] = useState(0);

  // Agent job handlers
  const handleAgentCreated = useCallback(() => {
    setAgentRefreshKey((k) => k + 1);
  }, []);

  const handleAgentEdit = useCallback((job: AgentJobDefinition) => {
    setEditingAgent(job);
    setShowAgentDialog(true);
  }, []);

  const handleAgentDialogClose = useCallback((open: boolean) => {
    setShowAgentDialog(open);
    if (!open) setEditingAgent(null);
  }, []);

  // Legacy job handlers
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

  // Watcher handlers
  const handleWatcherCreated = useCallback(() => {
    setWatcherRefreshKey((k) => k + 1);
  }, []);

  const handleWatcherEdit = useCallback((watcher: ScriptWatcher) => {
    setEditingWatcher(watcher);
    setShowWatcherDialog(true);
  }, []);

  const handleWatcherDialogClose = useCallback((open: boolean) => {
    setShowWatcherDialog(open);
    if (!open) setEditingWatcher(null);
  }, []);

  return (
    <Page>
      {/* Toolbar. one action for the kind of job on this page */}
      <PageToolbar>
        {section === "agents" && (
          <Button
            size="icon"
            className="h-8 w-8 md:h-auto md:w-auto md:px-3"
            onClick={() => setShowAgentDialog(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">New agent</span>
          </Button>
        )}
        {section === "scheduled" && (
          <Button
            size="icon"
            className="h-8 w-8 md:h-auto md:w-auto md:px-3"
            onClick={() => setShowJobDialog(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">New job</span>
          </Button>
        )}
        {section === "watchers" && (
          <Button
            size="icon"
            className="h-8 w-8 md:h-auto md:w-auto md:px-3"
            onClick={() => setShowWatcherDialog(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">New watcher</span>
          </Button>
        )}
      </PageToolbar>

      {section === "agents" && (
        <PageScroll>
          <AgentJobList
            key={agentRefreshKey}
            onEdit={handleAgentEdit}
            onRefresh={handleAgentCreated}
          />
        </PageScroll>
      )}

      {section === "scheduled" && (
        <PageScroll>
          <JobList key={jobRefreshKey} onEdit={handleJobEdit} onRefresh={handleJobCreated} />
        </PageScroll>
      )}

      {section === "watchers" && (
        <PageScroll>
          <WatcherList
            key={watcherRefreshKey}
            onEdit={handleWatcherEdit}
            onRefresh={handleWatcherCreated}
          />
        </PageScroll>
      )}

      {/* Agent Job Dialog */}
      <AgentJobDialog
        open={showAgentDialog}
        onOpenChange={handleAgentDialogClose}
        onSuccess={handleAgentCreated}
        job={editingAgent}
      />

      {/* Legacy Job Dialog */}
      <JobDialog
        open={showJobDialog}
        onOpenChange={handleJobDialogClose}
        onSuccess={handleJobCreated}
        job={editingJob}
      />

      {/* Watcher Dialog */}
      <WatcherDialog
        open={showWatcherDialog}
        onOpenChange={handleWatcherDialogClose}
        onSuccess={handleWatcherCreated}
        watcher={editingWatcher}
      />
    </Page>
  );
}
