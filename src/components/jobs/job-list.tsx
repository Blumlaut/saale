"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
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
  Settings,
  Calendar,
  Brain,
  Pencil,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { fetchJson, patchJson, deleteJson } from "@/lib/http";
import { GlassPanelHeader } from "@/components/ui/glass-panel";
import { ConfigDisplay } from "@/components/jobs/config-form";
import type { JobSchema } from "@/types/shared";

interface JobConfig {
  cronExpression?: string;
  accountId?: string;
  limit?: number;
  spamThreshold?: number;
  modelId?: string;
  [key: string]: unknown;
}

interface Job {
  id: string;
  type: string;
  enabled: boolean;
  modelId: string | null;
  config: JobConfig;
  lastRunAt: string | null;
  runCount: number;
  runHistoryCount: number;
  latestRunStatus: string | null;
  createdAt: string;
}

interface JobRun {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
}

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

function getModelLabel(modelId: string | null): string | null {
  if (!modelId) return null;
  // Normalize "/" to ":" for consistent display
  const normalized = modelId.includes("/") ? modelId.replace("/", ":") : modelId;
  const [provider, ...nameParts] = normalized.split(":");
  return `${nameParts.join(":")} (${provider})`;
}

interface JobListProps {
  onRefresh?: () => void;
  onEdit?: (job: Job) => void;
}

export function JobList({ onRefresh, onEdit }: JobListProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [schemas, setSchemas] = useState<JobSchema[]>([]);

  const loadJobs = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await fetchJson<{ jobs: Job[] }>("/api/jobs");
        const sorted = data.jobs.sort((a, b) => {
          const labelA = schemas.find((s) => s.type === a.type)?.label ?? a.type;
          const labelB = schemas.find((s) => s.type === b.type)?.label ?? b.type;
          return labelA.localeCompare(labelB);
        });
        setJobs(sorted);

        // Clear runningId for any jobs that are no longer running
        setRunningId((currentId) => {
          if (!currentId) return null;
          const job = data.jobs.find((j) => j.id === currentId);
          if (job && job.latestRunStatus === "running") return currentId;
          return null;
        });
      } catch {
        // Ignore
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [schemas],
  );

  const loadSchemas = useCallback(async () => {
    try {
      const data = await fetchJson<{ schemas: JobSchema[] }>("/api/jobs/schemas");
      setSchemas(data.schemas ?? []);
    } catch {
      // Ignore
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string, silent = false) => {
    if (!silent) setLoadingRuns(true);
    try {
      const data = await fetchJson<{ runs: JobRun[] }>(`/api/jobs/${jobId}/runs?limit=10`);
      setRuns(data.runs);
    } catch {
      // Ignore
    } finally {
      if (!silent) setLoadingRuns(false);
    }
  }, []);

  // Refs for polling — avoids re-creating the interval when callbacks change
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
    loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  useEffect(() => {
    if (selectedJob) {
      loadRuns(selectedJob.id);
    }
  }, [selectedJob, loadRuns]);

  // Poll for job state updates every 5 seconds (silent — no loading states)
  // Uses refs so the effect runs only once on mount
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
      await fetchJson(`/api/jobs/${jobId}`, { method: "POST" });
      // Don't clear runningId here — the next silent poll will clear it
      // once the job is no longer in "running" status
    } catch {
      setRunningId(null);
    }
  };

  const handleToggle = async (jobId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/jobs/${jobId}`, { enabled });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, enabled } : j)));
      onRefresh?.();
    } catch {
      // Ignore
    }
  };

  const handleDelete = async (jobId: string) => {
    try {
      await deleteJson(`/api/jobs/${jobId}`);
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      onRefresh?.();
      if (selectedJob?.id === jobId) {
        setSelectedJob(null);
        setRuns([]);
      }
    } catch {
      // Ignore
    }
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
      default:
        return (
          <Badge variant="secondary">
            <Clock className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
    }
  };

  const jobSchema = selectedJob ? schemas.find((s) => s.type === selectedJob.type) : null;

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-5">
      {/* Job list */}
      <div className="min-w-0 lg:col-span-2">
        <GlassPanel className="h-full">
          <GlassPanelHeader title="Jobs" />
          <GlassPanelContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <p className="text-muted-foreground text-sm">No jobs configured</p>
              </div>
            ) : (
              jobs.map((job, i) => {
                const schema = schemas.find((s) => s.type === job.type);
                return (
                  <div key={job.id}>
                    <div
                      className={cn(
                        "hover:bg-accent/60 flex items-center gap-3 px-4 py-3 transition-colors",
                        selectedJob?.id === job.id && "bg-accent",
                      )}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSelectedJob(job)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {schema?.label ?? job.type}
                          </span>
                          {schema?.usesAi && job.modelId && (
                            <Badge variant="secondary" className="max-w-[12rem] truncate text-xs">
                              <Brain className="mr-1 h-3 w-3" />
                              {getModelLabel(job.modelId)}
                            </Badge>
                          )}
                          <Switch
                            checked={job.enabled}
                            onCheckedChange={(checked) => handleToggle(job.id, checked)}
                            onClick={(e) => e.stopPropagation()}
                            className="scale-75"
                          />
                        </div>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                          {job.config?.cronExpression && (
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {getCronLabel(job.config.cronExpression as string)}
                            </span>
                          )}
                          {job.lastRunAt && (
                            <>
                              <span>·</span>
                              <span>
                                {formatDistanceToNow(new Date(job.lastRunAt), {
                                  addSuffix: true,
                                })}
                              </span>
                            </>
                          )}
                        </div>
                      </button>
                      <div className="flex items-center gap-1">
                        {job.latestRunStatus === "running" ? (
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
                      </div>
                    </div>
                    {i < jobs.length - 1 && <Separator className="px-4" />}
                  </div>
                );
              })
            )}
          </GlassPanelContent>
        </GlassPanel>
      </div>

      {/* Job detail / run history */}
      <div className="min-w-0 lg:col-span-3">
        <GlassPanel className="h-full">
          {selectedJob ? (
            <>
              <GlassPanelHeader title={jobSchema?.label ?? selectedJob.type} />
              <GlassPanelContent className="flex flex-col gap-6">
                {/* Config summary */}
                <div>
                  <h3 className="mb-3 text-sm font-medium">Configuration</h3>
                  <div className="flex flex-col gap-3">
                    {/* Cron */}
                    {selectedJob.config?.cronExpression && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground text-sm">Schedule</span>
                        <span className="text-sm font-medium">
                          {getCronLabel(selectedJob.config.cronExpression as string)}
                          <span className="text-muted-foreground ml-1.5 font-normal">
                            ({selectedJob.config.cronExpression})
                          </span>
                        </span>
                      </div>
                    )}
                    {/* Model override */}
                    {jobSchema?.usesAi && selectedJob.modelId && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                          <Brain className="h-3.5 w-3.5" />
                          AI Model
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {getModelLabel(selectedJob.modelId)}
                        </Badge>
                      </div>
                    )}
                    {jobSchema?.usesAi && !selectedJob.modelId && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                          <Brain className="h-3.5 w-3.5" />
                          AI Model
                        </span>
                        <span className="text-muted-foreground text-xs">Default</span>
                      </div>
                    )}
                    <Separator />
                    {/* Schema-driven fields */}
                    {jobSchema ? (
                      <ConfigDisplay fields={jobSchema.fields} values={selectedJob.config} />
                    ) : (
                      /* Fallback: show raw config */
                      Object.entries(selectedJob.config)
                        .filter(([key]) => key !== "cronExpression")
                        .map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between">
                            <span className="text-muted-foreground text-sm">{key}</span>
                            <span className="text-sm font-medium">
                              {typeof value === "object"
                                ? JSON.stringify(value)
                                : String(value as string | number | boolean)}
                            </span>
                          </div>
                        ))
                    )}
                  </div>
                </div>

                <Separator />

                {/* Run history */}
                <div>
                  <h3 className="mb-3 text-sm font-medium">Run History</h3>
                  {loadingRuns ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                    </div>
                  ) : runs.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No runs yet</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {runs.map((run) => (
                        <div
                          key={run.id}
                          className="bg-accent rounded-xl border p-3 dark:bg-white/5"
                        >
                          <div className="flex items-center justify-between">
                            {getStatusBadge(run.status)}
                            <span className="text-muted-foreground text-xs">
                              {run.startedAt
                                ? formatDistanceToNow(new Date(run.startedAt), {
                                    addSuffix: true,
                                  })
                                : ""}
                            </span>
                          </div>
                          {run.error && (
                            <div className="text-destructive mt-2 text-xs">{run.error}</div>
                          )}
                          {run.output && (
                            <pre className="bg-muted/50 mt-2 max-h-32 overflow-auto rounded-lg p-2 text-xs">
                              {JSON.stringify(run.output, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </GlassPanelContent>
            </>
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
    </div>
  );
}
