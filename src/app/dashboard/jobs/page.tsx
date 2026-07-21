"use client";

import { useState, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Plus, Bot, RefreshCw } from "lucide-react";
import { JobList } from "@/components/jobs/job-list";
import { JobDialog } from "@/components/jobs/job-dialog";
import { AgentJobList } from "@/components/jobs/agent-job-list";
import { AgentJobDialog } from "@/components/jobs/agent-job-dialog";
import type { AgentJobDefinition } from "@/types/shared";

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

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Jobs</h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">
            Automated tasks and AI agents
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="agents" className="gap-2">
              <Bot className="h-4 w-4" />
              Agent Jobs
            </TabsTrigger>
            <TabsTrigger value="scheduled" className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Scheduled Jobs
            </TabsTrigger>
          </TabsList>

          {activeTab === "agents" && (
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 md:h-9 md:w-auto md:px-3"
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
              className="h-8 w-8 md:h-9 md:w-auto md:px-3"
              onClick={() => setShowJobDialog(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">New Job</span>
            </Button>
          )}
        </div>

        {/* Agent Jobs tab */}
        <TabsContent value="agents" className="mt-4">
          <AgentJobList
            key={agentRefreshKey}
            onEdit={handleAgentEdit}
            onRefresh={handleAgentCreated}
          />
        </TabsContent>

        {/* Scheduled Jobs tab */}
        <TabsContent value="scheduled" className="mt-4">
          <JobList key={jobRefreshKey} onEdit={handleJobEdit} onRefresh={handleJobCreated} />
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
    </div>
  );
}
