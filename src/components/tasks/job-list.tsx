"use client";

import { useEffect, useState, useCallback } from "react";
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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { GlassPanelHeader } from "@/components/ui/glass-panel";
import { ConfigDisplay, type FieldDef } from "@/components/tasks/config-form";

interface Job {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  runCount: number;
  runHistoryCount: number;
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

interface JobSchema {
  type: string;
  label: string;
  description: string;
  fields: FieldDef[];
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

export function JobList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [schemas, setSchemas] = useState<JobSchema[]>([]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSchemas = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs/schemas");
      if (res.ok) {
        const data = await res.json();
        setSchemas(data.schemas ?? []);
      }
    } catch {
      // Ignore
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string) => {
    setLoadingRuns(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/runs?limit=10`);
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    loadSchemas();
  }, [loadJobs, loadSchemas]);

  useEffect(() => {
    if (selectedJob) {
      loadRuns(selectedJob.id);
    }
  }, [selectedJob, loadRuns]);

  const handleRun = async (jobId: string) => {
    setRunningId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: "POST",
      });
      if (res.ok) {
        loadJobs();
        if (selectedJob?.id === jobId) {
          loadRuns(jobId);
        }
      }
    } catch {
      // Ignore
    } finally {
      setRunningId(null);
    }
  };

  const handleToggle = async (jobId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, enabled } : j)));
      }
    } catch {
      // Ignore
    }
  };

  const handleDelete = async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        if (selectedJob?.id === jobId) {
          setSelectedJob(null);
          setRuns([]);
        }
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

  const jobSchema = selectedJob
    ? schemas.find((s) => s.type === selectedJob.type)
    : null;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {/* Job list */}
      <div className="lg:col-span-2">
        <GlassPanel className="h-full">
          <GlassPanelHeader title="Jobs" />
          <GlassPanelContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <p className="text-muted-foreground text-sm">No jobs configured</p>
              </div>
            ) : (
              jobs.map((job, i) => (
                <div key={job.id}>
                  <div
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                      selectedJob?.id === job.id && "bg-white/20 dark:bg-white/5",
                    )}
                  >
                    <button className="flex-1 text-left" onClick={() => setSelectedJob(job)}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {jobSchema?.label ?? job.type}
                        </span>
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
              ))
            )}
          </GlassPanelContent>
        </GlassPanel>
      </div>

      {/* Job detail / run history */}
      <div className="lg:col-span-3">
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
                    <Separator />
                    {/* Schema-driven fields */}
                    {jobSchema ? (
                      <ConfigDisplay
                        fields={jobSchema.fields}
                        values={selectedJob.config}
                      />
                    ) : (
                      /* Fallback: show raw config */
                      Object.entries(selectedJob.config)
                        .filter(([key]) => key !== "cronExpression")
                        .map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between">
                            <span className="text-muted-foreground text-sm">{key}</span>
                            <span className="text-sm font-medium">
                              {typeof value === "object" ? JSON.stringify(value) : String(value)}
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
                          className="rounded-xl border bg-white/20 p-3 dark:bg-white/5"
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
