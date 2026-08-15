"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Play,
  Loader2,
  Clock,
  CheckCircle,
  AlertCircle,
  Trash2,
  Bot,
  Pencil,
  Calendar,
  MessageSquare,
  Settings,
  ChevronRight,
  Lock,
  Ban,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { fetchJson, patchJson, deleteJson } from "@/lib/http";
import type { AgentJobDefinition, AgentJobRun } from "@/types/shared";

const cronExamples: Record<string, string> = {
  "* * * * *": "Every minute",
  "*/5 * * * *": "Every 5 minutes",
  "*/30 * * * *": "Every 30 minutes",
  "0 * * * *": "Every hour",
  "0 */6 * * *": "Every 6 hours",
  "0 9 * * *": "Daily at 9am",
  "0 9 * * 1": "Monday at 9am",
};

function getCronLabel(expr: string): string {
  return cronExamples[expr] ?? expr;
}

interface AgentJobListProps {
  onRefresh?: () => void;
  onEdit?: (job: AgentJobDefinition) => void;
}

export function AgentJobList({ onRefresh, onEdit }: AgentJobListProps) {
  const [jobs, setJobs] = useState<AgentJobDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<AgentJobDefinition | null>(null);
  const [runs, setRuns] = useState<AgentJobRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [selectedRun, setSelectedRun] = useState<AgentJobRun | null>(null);

  const loadJobs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchJson<{ definitions: AgentJobDefinition[] }>(
        "/api/agent-jobs/definitions",
      );
      setJobs(data.definitions ?? []);

      // Clear runningId for any jobs that are no longer running
      setRunningId((currentId) => {
        if (!currentId) return null;
        const job = data.definitions?.find((j) => j.id === currentId);
        if (job && job.latestRun?.status === "running") return currentId;
        return null;
      });
    } catch (err) {
      console.error("Failed to load agent jobs:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string, silent = false) => {
    if (!silent) setLoadingRuns(true);
    try {
      const data = await fetchJson<{ runs: AgentJobRun[] }>(
        `/api/agent-jobs/definitions/${jobId}/runs?limit=10`,
      );
      setRuns(data.runs ?? []);
    } catch (err) {
      console.error("Failed to load runs:", err);
    } finally {
      if (!silent) setLoadingRuns(false);
    }
  }, []);

  // Refs for polling
  const loadJobsRef = useRef(loadJobs);
  const loadRunsRef = useRef(loadRuns);
  const selectedJobRef = useRef(selectedJob);

  useEffect(() => {
    loadJobsRef.current = loadJobs;
    loadRunsRef.current = loadRuns;
    selectedJobRef.current = selectedJob;
  });

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  useEffect(() => {
    if (selectedJob) {
      loadRuns(selectedJob.id);
    }
  }, [selectedJob, loadRuns]);

  // Poll every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadJobsRef.current(true);
      if (selectedJobRef.current) {
        loadRunsRef.current(selectedJobRef.current.id, true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRun = async (jobId: string) => {
    setRunningId(jobId);
    try {
      await fetchJson(`/api/agent-jobs/definitions/${jobId}/runs`, { method: "POST" });
    } catch (err) {
      console.error("Failed to run agent job:", err);
      setRunningId(null);
    }
  };

  const handleToggle = async (jobId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/agent-jobs/definitions/${jobId}`, { enabled });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, enabled } : j)));
      onRefresh?.();
    } catch (err) {
      console.error("Failed to toggle agent job:", err);
    }
  };

  const handleDelete = async (jobId: string) => {
    try {
      await deleteJson(`/api/agent-jobs/definitions/${jobId}`);
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      onRefresh?.();
      if (selectedJob?.id === jobId) {
        setSelectedJob(null);
        setRuns([]);
      }
    } catch (err) {
      console.error("Failed to delete agent job:", err);
    }
  };

  const handleSelectRun = async (run: AgentJobRun) => {
    setSelectedRun(run);
    setShowMessages(true);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">
            <CheckCircle className="mr-1 h-3 w-3" />
            Completed
          </Badge>
        );
      case "error":
        return (
          <Badge variant="secondary" className="bg-destructive/10 text-destructive">
            <AlertCircle className="mr-1 h-3 w-3" />
            Error
          </Badge>
        );
      case "running":
        return (
          <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            Running
          </Badge>
        );
      case "cancelled":
        return (
          <Badge variant="secondary" className="bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">
            <Ban className="mr-1 h-3 w-3" />
            Cancelled
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary">
            <Clock className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
    }
  };

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-5">
      {/* Job list */}
      <div className="min-w-0 lg:col-span-2">
        <GlassPanel className="h-full">
          <GlassPanelHeader title="Agent Jobs" />
          <GlassPanelContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Bot className="text-muted-foreground/30 mb-3 h-10 w-10" />
                <p className="text-muted-foreground text-sm">No agent jobs configured</p>
              </div>
            ) : (
              jobs.map((job, i) => (
                <div key={job.id}>
                  <div
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                      selectedJob?.id === job.id && "bg-white/20 dark:bg-white/5",
                    )}
                    onClick={() => setSelectedJob(job)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{job.name}</span>
                        {job.systemManaged && (
                          <Badge variant="secondary" className="text-xs">
                            <Lock className="mr-1 h-3 w-3" />
                            Managed
                          </Badge>
                        )}
                        {!job.enabled && (
                          <Badge variant="secondary" className="text-xs">
                            Disabled
                          </Badge>
                        )}
                        {job.outputChannel && (
                          <Badge variant="secondary" className="text-xs capitalize">
                            {job.outputChannel}
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                        {job.cronExpression && (
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {getCronLabel(job.cronExpression)}
                          </span>
                        )}
                        {job.lastRunAt && (
                          <>
                            <span>·</span>
                            <span>
                              {formatDistanceToNow(new Date(job.lastRunAt), { addSuffix: true })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {job.systemManaged ? (
                        <Lock
                          className="text-muted-foreground/60 mx-1 h-3.5 w-3.5"
                          aria-label="Managed by Saale — locked"
                        />
                      ) : (
                        <>
                          {job.latestRun?.status === "running" ? (
                            <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
                              <Loader2 className="h-3 w-3 animate-spin" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => handleRun(job.id)}
                              disabled={runningId === job.id}
                            >
                              {runningId === job.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                            </Button>
                          )}
                          <Switch
                            checked={job.enabled}
                            onCheckedChange={(checked) => handleToggle(job.id, checked)}
                            className="scale-75"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onEdit?.(job)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleDelete(job.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {i < jobs.length - 1 && <Separator className="px-4" />}
                </div>
              ))
            )}
          </GlassPanelContent>
        </GlassPanel>
      </div>

      {/* Job detail / run history */}
      <div className="min-w-0 lg:col-span-3">
        <GlassPanel className="h-full">
          {selectedJob ? (
            <div className="flex h-full flex-col">
              <GlassPanelHeader title={selectedJob.name} />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <GlassPanelContent className="flex flex-col gap-6">
                  {/* Job info */}
                  <div className="flex flex-col gap-3">
                    {selectedJob.systemManaged && (
                      <div className="text-muted-foreground flex items-start gap-2 rounded-lg border bg-white/5 p-3 text-xs">
                        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Managed by Saale — this job powers Telegram chat. Its configuration is
                          locked; customize the chat in Settings.
                        </span>
                      </div>
                    )}
                    {selectedJob.description && (
                      <p className="text-muted-foreground text-sm">{selectedJob.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {selectedJob.runCount} runs
                      </Badge>
                      {selectedJob.modelId && (
                        <Badge variant="secondary" className="text-xs">
                          {selectedJob.modelId}
                        </Badge>
                      )}
                      {selectedJob.outputChannel && (
                        <Badge variant="secondary" className="text-xs capitalize">
                          → {selectedJob.outputChannel}
                          {selectedJob.outputChannelId ? ` (${selectedJob.outputChannelId})` : ""}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Prompt */}
                  {selectedJob.prompt && (
                    <div>
                      <h3 className="mb-2 text-sm font-medium">Prompt</h3>
                      <div className="rounded-lg border bg-white/5 p-3">
                        <p className="text-sm whitespace-pre-wrap">{selectedJob.prompt}</p>
                      </div>
                    </div>
                  )}

                  {selectedJob.systemPrompt && (
                    <div>
                      <h3 className="mb-2 text-sm font-medium">System Prompt</h3>
                      <div className="rounded-lg border bg-white/5 p-3">
                        <p className="text-sm whitespace-pre-wrap">{selectedJob.systemPrompt}</p>
                      </div>
                    </div>
                  )}

                  <Separator />

                  {/* Run history */}
                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Run History</h3>
                    {loadingRuns ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                      </div>
                    ) : runs.length === 0 ? (
                      <p className="text-muted-foreground text-sm">No runs yet</p>
                    ) : (
                      runs.map((run) => (
                        <div
                          key={run.id}
                          className={cn(
                            "cursor-pointer rounded-xl border p-3 transition-colors hover:bg-white/10",
                            selectedRun?.id === run.id && "bg-white/10",
                          )}
                          onClick={() => handleSelectRun(run)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {getStatusBadge(run.status)}
                              <span className="text-muted-foreground text-xs">
                                {run.startedAt
                                  ? formatDistanceToNow(new Date(run.startedAt), {
                                      addSuffix: true,
                                    })
                                  : ""}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {run.messageCount > 0 && (
                                <Badge variant="secondary" className="text-xs">
                                  <MessageSquare className="mr-1 h-3 w-3" />
                                  {run.messageCount}
                                </Badge>
                              )}
                              <ChevronRight className="text-muted-foreground h-3 w-3" />
                            </div>
                          </div>
                          {run.error && (
                            <div className="text-destructive mt-2 text-xs">{run.error}</div>
                          )}
                          {run.inputTokens > 0 && (
                            <div className="text-muted-foreground mt-1 text-xs">
                              {run.inputTokens} in · {run.outputTokens} out · $
                              {run.cost?.toFixed(4)}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </GlassPanelContent>
              </div>
            </div>
          ) : (
            <GlassPanelContent className="flex items-center justify-center py-16">
              <div className="text-center">
                <Settings className="text-muted-foreground/30 mx-auto mb-3 h-12 w-12" />
                <p className="text-muted-foreground text-sm">Select a job to view details</p>
              </div>
            </GlassPanelContent>
          )}
        </GlassPanel>
      </div>

      {/* Messages dialog */}
      <RunMessagesDialog
        open={showMessages}
        onOpenChange={setShowMessages}
        runId={selectedRun?.id ?? null}
      />
    </div>
  );
}

/** Messages dialog for a run */
function RunMessagesDialog({
  open,
  onOpenChange,
  runId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string | null;
}) {
  const [messages, setMessages] = useState<
    Array<{
      id: string;
      role: string;
      content: string;
      thinking: string | null;
      toolCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        result?: string;
        isError?: boolean;
      }> | null;
      createdAt: string;
    }>
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !runId) return;
    setLoading(true);
    fetchJson<{ messages: typeof messages }>(`/api/agent-jobs/runs/${runId}/messages`)
      .then((data) => setMessages(data.messages ?? []))
      .catch((err) => console.error("Failed to load messages:", err))
      .finally(() => setLoading(false));
  }, [open, runId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run Messages</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60dvh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">No messages</p>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "rounded-lg border p-3",
                    msg.role === "user" ? "bg-white/5" : "bg-white/10",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs capitalize">
                      {msg.role}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  {msg.content && <p className="mt-2 text-sm whitespace-pre-wrap">{msg.content}</p>}
                  {msg.thinking && (
                    <details className="mt-2">
                      <summary className="text-muted-foreground cursor-pointer text-xs">
                        Thinking
                      </summary>
                      <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">
                        {msg.thinking}
                      </p>
                    </details>
                  )}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {msg.toolCalls.map((tc) => (
                        <div key={tc.id} className="rounded-md bg-white/5 p-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{tc.name}</span>
                            {tc.isError && (
                              <Badge
                                variant="secondary"
                                className="bg-destructive/10 text-destructive text-[10px]"
                              >
                                Error
                              </Badge>
                            )}
                          </div>
                          <pre className="text-muted-foreground mt-1 overflow-x-auto">
                            {JSON.stringify(tc.args, null, 2)}
                          </pre>
                          {tc.result !== undefined && tc.result !== "" && (
                            <pre className="mt-1 overflow-x-auto">→ {tc.result}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Import Dialog components
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
