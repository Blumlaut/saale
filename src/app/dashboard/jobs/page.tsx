"use client";

import { useState, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Plus, Bot, RefreshCw, Radar } from "lucide-react";
import { Page, PageTabStrip } from "@/components/layout/page";
import { JobList } from "@/components/jobs/job-list";
import { JobDialog } from "@/components/jobs/job-dialog";
import { AgentJobList } from "@/components/jobs/agent-job-list";
import { AgentJobDialog } from "@/components/jobs/agent-job-dialog";
import { WatcherList } from "@/components/jobs/watcher-list";
import { WatcherDialog } from "@/components/jobs/watcher-dialog";
import type { AgentJobDefinition, ScriptWatcher } from "@/types/shared";

export default function JobsPage() {
  const [activeTab, setActiveTab] = useState("agents");

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
      {/* Tabs — strip pinned, content scrolls internally */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <PageTabStrip className="min-w-0 flex-1">
            <TabsList>
              <TabsTrigger value="agents" className="gap-2">
                <Bot className="h-4 w-4" />
                Agent Jobs
              </TabsTrigger>
              <TabsTrigger value="scheduled" className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Scheduled Jobs
              </TabsTrigger>
              <TabsTrigger value="watchers" className="gap-2">
                <Radar className="h-4 w-4" />
                Watchers
              </TabsTrigger>
            </TabsList>
          </PageTabStrip>

          {activeTab === "agents" && (
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 shrink-0 md:h-9 md:w-auto md:px-3"
              onClick={() => setShowAgentDialog(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">New Agent</span>
            </Button>
          )}
          {activeTab === "scheduled" && (
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 shrink-0 md:h-9 md:w-auto md:px-3"
              onClick={() => setShowJobDialog(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">New Job</span>
            </Button>
          )}
          {activeTab === "watchers" && (
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 shrink-0 md:h-9 md:w-auto md:px-3"
              onClick={() => setShowWatcherDialog(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">New Watcher</span>
            </Button>
          )}
        </div>

        {/* Agent Jobs tab — the only scroll region below the strip */}
        <TabsContent value="agents" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <AgentJobList
            key={agentRefreshKey}
            onEdit={handleAgentEdit}
            onRefresh={handleAgentCreated}
          />
        </TabsContent>

        {/* Scheduled Jobs tab */}
        <TabsContent value="scheduled" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <JobList key={jobRefreshKey} onEdit={handleJobEdit} onRefresh={handleJobCreated} />
        </TabsContent>

        {/* Watchers tab */}
        <TabsContent value="watchers" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <WatcherList
            key={watcherRefreshKey}
            onEdit={handleWatcherEdit}
            onRefresh={handleWatcherCreated}
          />
        </TabsContent>
      </Tabs>

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
