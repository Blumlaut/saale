"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertCircle,
  AlertTriangle,
  BellOff,
  CheckCircle,
  Clock,
  FolderGit2,
  Lock,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Radar,
  ShieldCheck,
  Timer,
  Trash2,
  Zap,
  Ban,
} from "lucide-react";
import { cn, ROW_ACTION } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { fetchJson, patchJson, deleteJson } from "@/lib/http";
import type { ScriptWatcher, ScriptWatcherTick } from "@/types/shared";

const cronExamples: Record<string, string> = {
  "* * * * *": "Every minute",
  "*/5 * * * *": "Every 5 minutes",
  "*/10 * * * *": "Every 10 minutes",
  "*/30 * * * *": "Every 30 minutes",
  "0 * * * *": "Every hour",
  "0 */6 * * *": "Every 6 hours",
  "0 9 * * *": "Daily at 9am",
};

function getCronLabel(expr: string): string {
  return cronExamples[expr] ?? expr;
}

/** The tick outcome, as a badge the user can read at a glance. */
function TickBadge({ status }: { status: string }) {
  switch (status) {
    case "fired":
      return (
        <Badge
          variant="secondary"
          className="bg-orange-500/10 text-orange-600 dark:text-orange-400"
        >
          <Zap className="mr-1 h-3 w-3" />
          Fired
        </Badge>
      );
    case "reported":
      return (
        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Reported
        </Badge>
      );
    case "error":
      return (
        <Badge variant="secondary" className="bg-destructive/10 text-destructive">
          <AlertCircle className="mr-1 h-3 w-3" />
          Error
        </Badge>
      );
    case "blocked":
      return (
        <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Lock className="mr-1 h-3 w-3" />
          Blocked
        </Badge>
      );
    case "cooldown":
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Timer className="mr-1 h-3 w-3" />
          Cooling down
        </Badge>
      );
    case "idle":
      return (
        <Badge variant="secondary">
          <CheckCircle className="mr-1 h-3 w-3" />
          Nothing new
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Ban className="mr-1 h-3 w-3" />
          {status}
        </Badge>
      );
  }
}

interface WatcherListProps {
  onRefresh?: () => void;
  onEdit?: (watcher: ScriptWatcher) => void;
}

export function WatcherList({ onRefresh, onEdit }: WatcherListProps) {
  const router = useRouter();
  const [watchers, setWatchers] = useState<ScriptWatcher[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ticks, setTicks] = useState<ScriptWatcherTick[]>([]);
  const [loadingTicks, setLoadingTicks] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const openChat = useCallback(
    (sessionId: string) => router.push(`/dashboard/chat/${sessionId}`),
    [router],
  );

  const loadWatchers = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchJson<{ watchers: ScriptWatcher[] }>("/api/watchers");
      setWatchers(data.watchers ?? []);
    } catch (err) {
      console.error("Failed to load watchers:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadTicks = useCallback(async (watcherId: string) => {
    setLoadingTicks(true);
    try {
      const data = await fetchJson<{ ticks: ScriptWatcherTick[] }>(`/api/watchers/${watcherId}`);
      setTicks(data.ticks ?? []);
    } catch (err) {
      console.error("Failed to load watcher ticks:", err);
    } finally {
      setLoadingTicks(false);
    }
  }, []);

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    void loadWatchers();
    // Keep the list and the open tick log current while the page is open.
    const interval = setInterval(() => {
      void loadWatchers(true);
      if (selectedIdRef.current) void loadTicks(selectedIdRef.current);
    }, 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  const selected = watchers.find((w) => w.id === selectedId) ?? null;

  const select = (watcher: ScriptWatcher) => {
    setSelectedId(watcher.id);
    void loadTicks(watcher.id);
  };

  const handleToggle = async (watcher: ScriptWatcher, enabled: boolean) => {
    try {
      await patchJson(`/api/watchers/${watcher.id}`, { enabled });
      setWatchers((prev) => prev.map((w) => (w.id === watcher.id ? { ...w, enabled } : w)));
      onRefresh?.();
    } catch (err) {
      console.error("Failed to toggle watcher:", err);
    }
  };

  const handleApprove = async (watcher: ScriptWatcher) => {
    setBusyId(watcher.id);
    try {
      await patchJson(`/api/watchers/${watcher.id}`, { approve: true });
      await loadWatchers(true);
      onRefresh?.();
    } catch (err) {
      console.error("Failed to approve watcher script:", err);
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (watcher: ScriptWatcher) => {
    setBusyId(watcher.id);
    try {
      // A real tick: recorded, and delivered if the script reports something.
      await fetchJson(`/api/watchers/${watcher.id}/tick`, {
        method: "POST",
        body: JSON.stringify({ preview: false }),
      });
      await loadWatchers(true);
      await loadTicks(watcher.id);
      onRefresh?.();
    } catch (err) {
      console.error("Failed to run watcher:", err);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (watcher: ScriptWatcher) => {
    try {
      await deleteJson(`/api/watchers/${watcher.id}`);
      setWatchers((prev) => prev.filter((w) => w.id !== watcher.id));
      if (selectedId === watcher.id) {
        setSelectedId(null);
        setTicks([]);
      }
      onRefresh?.();
    } catch (err) {
      console.error("Failed to delete watcher:", err);
    }
  };

  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-5">
      {/* Watchers */}
      <div className="min-w-0 lg:col-span-2">
        <GlassPanel className="h-full">
          <GlassPanelHeader title="Watchers" />
          <GlassPanelContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : watchers.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                <Radar className="text-muted-foreground/30 mb-3 h-10 w-10" />
                <p className="text-muted-foreground text-sm">No watchers configured</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  A watcher runs a script on a schedule and wakes the agent only when the script
                  reports something.
                </p>
              </div>
            ) : (
              watchers.map((watcher, i) => (
                <div key={watcher.id}>
                  <div
                    className={cn(
                      "group hover:bg-accent/60 flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors",
                      selectedId === watcher.id && "bg-accent",
                    )}
                    onClick={() => select(watcher)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{watcher.name}</span>
                        {watcher.needsApproval && (
                          <Badge
                            variant="secondary"
                            className="bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400"
                          >
                            <AlertTriangle className="mr-1 h-3 w-3" />
                            Needs approval
                          </Badge>
                        )}
                        {watcher.grantAll && (
                          <Badge variant="secondary" className="text-xs">
                            All tools
                          </Badge>
                        )}
                        {!watcher.enabled && (
                          <Badge variant="secondary" className="text-xs">
                            Disabled
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {getCronLabel(watcher.cronExpression)}
                        </span>
                        {watcher.deliver === "coder" ? (
                          <span className="inline-flex max-w-full items-center gap-1">
                            <FolderGit2 className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {watcher.projectName ?? "Project"}
                              {watcher.worktreeMode === "sticky" ? " · one worktree" : ""}
                            </span>
                          </span>
                        ) : watcher.deliver === "silent" ? (
                          <span className="inline-flex max-w-full items-center gap-1">
                            <BellOff className="h-3 w-3 shrink-0" />
                            <span className="truncate">Delivered by the script</span>
                          </span>
                        ) : watcher.sessionId ? (
                          <button
                            type="button"
                            className="hover:text-foreground inline-flex max-w-full items-center gap-1 hover:underline"
                            onClick={(event) => {
                              event.stopPropagation();
                              openChat(watcher.sessionId!);
                            }}
                            aria-label={`Open chat ${watcher.sessionTitle ?? watcher.name}`}
                          >
                            <MessageSquare className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {watcher.sessionTitle ?? "Conversation"}
                            </span>
                          </button>
                        ) : (
                          <span className="truncate">No target</span>
                        )}
                        {watcher.fireCount > 0 && <span>· fired {watcher.fireCount}×</span>}
                      </div>
                    </div>

                    <Switch
                      checked={watcher.enabled}
                      onCheckedChange={(checked) => void handleToggle(watcher, checked)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Enable ${watcher.name}`}
                    />

                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <span
                          className={cn(
                            ROW_ACTION,
                            "text-muted-foreground hover:bg-accent/60 inline-flex h-6 w-6 items-center justify-center rounded",
                          )}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        {watcher.needsApproval && (
                          <DropdownMenuItem onClick={() => void handleApprove(watcher)}>
                            <ShieldCheck className="mr-2 h-3.5 w-3.5" />
                            Approve script
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => void handleRunNow(watcher)}>
                          <Play className="mr-2 h-3.5 w-3.5" />
                          Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onEdit?.(watcher)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void handleDelete(watcher)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {i < watchers.length - 1 && <Separator />}
                </div>
              ))
            )}
          </GlassPanelContent>
        </GlassPanel>
      </div>

      {/* Tick log */}
      <div className="min-w-0 lg:col-span-3">
        <GlassPanel className="h-full">
          <GlassPanelHeader title={selected ? `Ticks · ${selected.name}` : "Ticks"}>
            {selected && busyId === selected.id && (
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            )}
          </GlassPanelHeader>
          <GlassPanelContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {!selected ? (
              <div className="text-muted-foreground flex items-center justify-center px-4 py-8 text-sm">
                Select a watcher to see what its script has been reporting.
              </div>
            ) : loadingTicks ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : (
              <>
                {selected.needsApproval && (
                  <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-3">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      The script changed after it was approved, so this watcher is paused. Approve
                      it to let it tick again.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={() => void handleApprove(selected)}
                      disabled={busyId === selected.id}
                    >
                      <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                      Approve script
                    </Button>
                  </div>
                )}

                {selected.lastError && (
                  <div className="border-destructive/20 bg-destructive/5 border-b px-4 py-3">
                    <p className="text-destructive text-xs break-words whitespace-pre-wrap">
                      {selected.lastError}
                    </p>
                  </div>
                )}

                {ticks.length === 0 ? (
                  <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                    This watcher has not ticked yet.
                  </div>
                ) : (
                  ticks.map((tick, i) => (
                    <div key={tick.id}>
                      <div className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <TickBadge status={tick.status} />
                          <span className="text-muted-foreground font-mono text-xs">
                            {formatRelativeDate(tick.createdAt)} · {tick.durationMs}ms
                            {tick.callCount > 0 && ` · ${tick.callCount} call(s)`}
                          </span>
                        </div>

                        {(tick.toolNames?.length ?? 0) > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {tick.toolNames!.map((name) => (
                              <Badge key={name} variant="secondary" className="font-mono text-xs">
                                {name}
                              </Badge>
                            ))}
                            {tick.sessionId && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => openChat(tick.sessionId!)}
                              >
                                <MessageSquare className="mr-1 h-3 w-3" />
                                Delivered chat
                              </Button>
                            )}
                          </div>
                        )}

                        {tick.value && (
                          <pre className="bg-muted/50 mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-xs break-all whitespace-pre-wrap">
                            {tick.value}
                          </pre>
                        )}
                        {tick.error && (
                          <p className="text-destructive mt-2 text-xs break-words whitespace-pre-wrap">
                            {tick.error}
                          </p>
                        )}
                        {tick.output && (
                          <pre className="text-muted-foreground mt-2 max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                            {tick.output}
                          </pre>
                        )}
                      </div>
                      {i < ticks.length - 1 && <Separator />}
                    </div>
                  ))
                )}

                {/* Approved tools are what the script may call unattended. */}
                <div className="border-t px-4 py-3">
                  <p className="text-muted-foreground text-xs font-medium">Approved tools</p>
                  {selected.grantedTools.length === 0 ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {selected.grantAll
                        ? "Every enabled tool."
                        : "None. this script only reads tools that never ask."}
                    </p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selected.grantedTools.map((name) => (
                        <Badge key={name} variant="secondary" className="font-mono text-xs">
                          {name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </GlassPanelContent>
        </GlassPanel>
      </div>
    </div>
  );
}
