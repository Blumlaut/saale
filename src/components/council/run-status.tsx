"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CouncilRunView } from "@/types/council";
import type { CouncilRunTotals } from "./use-council-stream";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Hourglass,
  Loader2,
  Play,
  UserCheck,
} from "lucide-react";

/** Budget ceilings a run can be convened with. Absent = inherit the council's. */
export interface RunBudgetInput {
  maxDurationSeconds?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  aborted: "Stopped",
  pending: "Queued",
};

/** Why a run ended, in words. */
export const STOP_REASON_LABELS: Record<string, string> = {
  consensus: "Stopped by consensus vote",
  "no-pending-work": "Nothing left to do",
  "budget:time": "Time budget reached",
  "budget:tokens": "Token budget reached",
  "budget:cost": "Cost budget reached",
  aborted: "Stopped by you",
  "user-question": "Paused for your answer",
  "no-members": "No enabled members",
  error: "Ended on an error",
};

/** The council's status, as a badge. */
export function CouncilStatusBadge({ status, className }: { status: string; className?: string }) {
  const label = STATUS_LABELS[status] ?? status;
  const tone =
    status === "running"
      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
      : status === "waiting"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : status === "failed"
          ? "bg-destructive/10 text-destructive"
          : status === "completed"
            ? "bg-green-500/10 text-green-600 dark:text-green-400"
            : "";

  return (
    <Badge variant="secondary" className={cn(tone, className)}>
      {status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {status === "waiting" && <Hourglass className="mr-1 h-3 w-3" />}
      {status === "completed" && <CheckCircle2 className="mr-1 h-3 w-3" />}
      {status === "failed" && <AlertCircle className="mr-1 h-3 w-3" />}
      {label}
    </Badge>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** A ceiling and how much of it is spent. `null` ceiling = unlimited. */
function Meter({
  icon,
  label,
  used,
  ceiling,
  format,
}: {
  icon: ReactNode;
  label: string;
  used: number;
  ceiling: number | null;
  format: (value: number) => string;
}) {
  const unlimited = ceiling === null || ceiling <= 0;
  const ratio = unlimited ? 0 : Math.min(1, used / ceiling);

  return (
    <div className="min-w-0 flex-1">
      <div className="console-label flex items-center gap-1">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-xs">{format(used)}</span>
        {unlimited ? (
          <span className="text-muted-foreground font-mono text-[10px]">/ unlimited</span>
        ) : (
          <span className="text-muted-foreground font-mono text-[10px]">/ {format(ceiling)}</span>
        )}
      </div>
      <div className="bg-muted mt-1 h-1 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            ratio >= 1 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

export interface RunStatusProps {
  councilStatus: string;
  /** The run to report on: the active one, or the most recent finished one. */
  run: CouncilRunView | null;
  running: boolean;
  /** Live totals accumulated from the stream while a run is in flight. */
  totals: CouncilRunTotals;
  connected: boolean;
  enabledMemberCount: number;
}

/**
 * The room's status strip: what the council is doing, why the last run ended,
 * and how much of the run's budget has been spent.
 */
export function RunStatus({
  councilStatus,
  run,
  running,
  totals,
  connected,
  enabledMemberCount,
}: RunStatusProps) {
  // Elapsed wall clock, ticked locally — the run's own start time is a timestamp.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running || !run?.startedAt) {
      setElapsed(0);
      return;
    }
    const startedAt = new Date(run.startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, (Date.now() - startedAt) / 1000));
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [running, run?.startedAt]);

  // While a run is in flight the stream's totals are authoritative: they are
  // seeded from the active run's record and then advanced by each turn's delta.
  // A finished run reports its own stored totals.
  const inputTokens = running ? totals.inputTokens : (run?.inputTokens ?? 0);
  const outputTokens = running ? totals.outputTokens : (run?.outputTokens ?? 0);
  const cost = running ? totals.cost : (run?.cost ?? 0);
  const turnCount = running ? totals.turnCount : (run?.turnCount ?? 0);

  const stopLabel = run?.stopReason ? (STOP_REASON_LABELS[run.stopReason] ?? run.stopReason) : null;

  return (
    <div className="border-b px-4 py-2 md:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <CouncilStatusBadge status={councilStatus} />
        {councilStatus === "waiting" && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <UserCheck className="h-3 w-3" />
            The room is waiting for you — reply below to continue.
          </span>
        )}
        {stopLabel && !running && (
          <span className="text-muted-foreground text-xs">{stopLabel}</span>
        )}
        {run?.error && <span className="text-destructive truncate text-xs">{run.error}</span>}
        <span className="text-muted-foreground font-mono text-xs">
          {turnCount} turn{turnCount === 1 ? "" : "s"}
        </span>
        {running && run?.startedAt && (
          <span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-xs">
            <Clock className="h-3 w-3" />
            {formatDuration(elapsed)}
          </span>
        )}
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-[10px] tracking-wide uppercase",
            connected ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-green-500" : "bg-amber-500")}
          />
          {connected ? "live" : "connecting"}
        </span>
      </div>

      {run && (
        <div className="mt-2 flex flex-wrap gap-3 md:gap-6">
          <Meter
            icon={<span className="font-mono">⇅</span>}
            label="Tokens"
            used={inputTokens + outputTokens}
            ceiling={run.maxTokens ?? null}
            format={formatTokens}
          />
          <Meter
            icon={<CircleDollarSign className="h-3 w-3" />}
            label="Cost"
            used={cost}
            ceiling={run.maxCostUsd ?? null}
            format={formatCost}
          />
          <div className="hidden min-w-0 flex-1 md:block">
            <div className="console-label">Members</div>
            <div className="mt-1 font-mono text-xs">{enabledMemberCount} enabled</div>
          </div>
        </div>
      )}
    </div>
  );
}

export interface ConveneButtonProps {
  disabled?: boolean;
  pending?: boolean;
  onConvene: (budget: RunBudgetInput) => void;
  /** The council's defaults, shown as placeholders in the budget fields. */
  defaults?: {
    maxDurationSeconds: number | null;
    maxTokens: number | null;
    maxCostUsd: number | null;
  };
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Convene — starts a run, with an optional per-run budget that overrides the
 * council's own for this run only. Left blank, the council's ceilings apply.
 */
export function ConveneButton({ disabled, pending, onConvene, defaults }: ConveneButtonProps) {
  const [open, setOpen] = useState(false);
  const [seconds, setSeconds] = useState("");
  const [tokens, setTokens] = useState("");
  const [cost, setCost] = useState("");

  const submit = () => {
    const budget: RunBudgetInput = {};
    const s = numberOrUndefined(seconds);
    const t = numberOrUndefined(tokens);
    const c = numberOrUndefined(cost);
    if (s !== undefined) budget.maxDurationSeconds = s;
    if (t !== undefined) budget.maxTokens = t;
    if (c !== undefined) budget.maxCostUsd = c;
    onConvene(budget);
    setOpen(false);
  };

  const placeholder = (value: number | null | undefined, unlimitedLabel: string) =>
    value === null || value === undefined ? unlimitedLabel : String(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(triggerProps) => (
          <Button
            size="sm"
            className="h-8 gap-1.5 md:h-9"
            disabled={disabled || pending}
            {...triggerProps}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            <span className="hidden md:inline">Convene</span>
            <span className="md:hidden">Run</span>
          </Button>
        )}
      />
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Convene the council</span>
          <span className="text-muted-foreground text-xs">
            Leave a budget blank to use the council&apos;s default. 0 means unlimited.
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <div className="space-y-1">
            <Label htmlFor="convene-seconds" className="text-xs">
              Time (seconds)
            </Label>
            <Input
              id="convene-seconds"
              inputMode="numeric"
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              placeholder={placeholder(defaults?.maxDurationSeconds ?? null, "unlimited")}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="convene-tokens" className="text-xs">
              Tokens
            </Label>
            <Input
              id="convene-tokens"
              inputMode="numeric"
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              placeholder={placeholder(defaults?.maxTokens ?? null, "unlimited")}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="convene-cost" className="text-xs">
              Cost (USD)
            </Label>
            <Input
              id="convene-cost"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder={placeholder(defaults?.maxCostUsd ?? null, "unlimited")}
              className="h-8"
            />
          </div>
        </div>

        <Button size="sm" onClick={submit} className="w-full">
          <Play className="h-4 w-4" />
          Convene
        </Button>
      </PopoverContent>
    </Popover>
  );
}
