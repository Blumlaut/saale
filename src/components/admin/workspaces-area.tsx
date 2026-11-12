"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, MoreVertical, RefreshCw, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { Page, PageAction, PageActions, PageScroll } from "@/components/layout/page";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import { cn, formatFileSize, ROW_ACTION } from "@/lib/utils";
import { formatRelativeDate, plural } from "@/lib/format";
import type { WorkspaceAudit, WorkspaceAuditRow } from "@/lib/admin/workspaces";

/** How often a running measurement is polled. */
const POLL_MS = 2000;

/** A visit this soon after a measurement shows the numbers it has. */
const FRESH_ENOUGH_MS = 60_000;

/** Owners with a colour of their own. The rest share one grey. */
const COLORED_OWNERS = 5;

/** Chart tokens, orange first. */
const SEGMENT_FILLS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

const OTHER_FILL = "bg-muted-foreground/40";

export function WorkspacesArea() {
  const [audit, setAudit] = useState<WorkspaceAudit | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const askedForMeasurement = useRef(false);

  const load = useCallback(async (): Promise<WorkspaceAudit | null> => {
    try {
      const next = await fetchJson<WorkspaceAudit>("/api/admin/workspaces");
      setAudit(next);
      setLoadError(false);
      return next;
    } catch (err) {
      console.error("Failed to load the workspace audit:", err);
      setLoadError(true);
      return null;
    }
  }, []);

  const measure = useCallback(async () => {
    setRefreshing(true);
    try {
      await postJson("/api/admin/workspaces", {});
    } catch (err) {
      console.error("Failed to start a workspace measurement:", err);
    } finally {
      setRefreshing(false);
    }
    await load();
  }, [load]);

  // First look: the last measurement, and a new one when those numbers are old.
  useEffect(() => {
    void (async () => {
      const first = await load();
      if (!first || askedForMeasurement.current) return;
      askedForMeasurement.current = true;
      const fresh = first.measuredAt !== null && Date.now() - first.measuredAt < FRESH_ENOUGH_MS;
      if (!fresh && !first.measuring) await measure();
    })();
  }, [load, measure]);

  // A measurement runs in the server; poll until it lands.
  useEffect(() => {
    if (!audit?.measuring) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [audit?.measuring, load]);

  const runPending = useCallback(async (): Promise<boolean> => {
    if (!pending) return false;
    const base = `/api/admin/workspaces/${encodeURIComponent(pending.row.identity)}`;
    try {
      await deleteJson(pending.kind === "delete" ? base : `${base}/container`);
      setPending(null);
      await load();
      return true;
    } catch (err) {
      console.error(`Failed to ${pending.kind} ${pending.row.identity}:`, err);
      return false;
    }
  }, [pending, load]);

  const rows = audit?.rows ?? [];
  const used = rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
  const largest = rows.reduce((max, row) => Math.max(max, row.bytes ?? 0), 0);
  const busiest = [...rows]
    .filter((row) => (row.bytes ?? 0) > 0)
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const fills = new Map(busiest.map((row, index) => [row.identity, fillFor(index)]));

  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions
          leading={
            <span className="text-muted-foreground truncate text-xs md:text-sm">
              {audit?.volume
                ? `${formatFileSize(used)} in ${plural(rows.length, "workspace", "workspaces")}`
                : "Volume unavailable"}
            </span>
          }
        >
          <span className="text-muted-foreground hidden text-xs whitespace-nowrap sm:inline">
            {audit?.measuring
              ? "measuring…"
              : audit?.measuredAt
                ? `measured ${formatRelativeDate(new Date(audit.measuredAt))}`
                : "not measured yet"}
          </span>
          <PageAction
            icon={RefreshCw}
            label="Refresh"
            busy={refreshing || audit?.measuring === true}
            onClick={() => void measure()}
          />
        </PageActions>

        <PageScroll>
          {audit && audit.volume ? (
            <VolumeSummary
              rows={busiest}
              fills={fills}
              used={used}
              total={audit.volume.total}
              free={audit.volume.free}
            />
          ) : null}

          {audit?.error ? (
            <p className="text-destructive border-border/50 border-b px-4 py-3 text-xs">
              The last measurement failed: {audit.error}
            </p>
          ) : null}

          {audit === null && !loadError ? <LoadingRows /> : null}

          {loadError && audit === null ? (
            <p className="text-muted-foreground px-4 py-6 text-sm">
              The audit could not be loaded. Refresh to try again.
            </p>
          ) : null}

          {audit !== null && rows.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-sm">
              No workspace has been created yet.
            </p>
          ) : null}

          {rows.map((row, index) => (
            <Fragment key={row.identity}>
              <WorkspaceRow
                row={row}
                fill={fills.get(row.identity) ?? OTHER_FILL}
                largest={largest}
                onAction={setPending}
              />
              {index < rows.length - 1 && <Separator className="px-4" />}
            </Fragment>
          ))}
        </PageScroll>
      </GlassPanel>

      <WorkspaceActionDialog
        pending={pending}
        onOpenChange={(open) => !open && setPending(null)}
        onConfirm={runPending}
      />
    </Page>
  );
}

/** The one action waiting for a confirmation. */
type PendingAction = { kind: "container" | "delete"; row: WorkspaceAuditRow };

/**
 * Confirmation for the two things an operator can do to a workspace.
 *
 * Delete removes a directory no account owns, and there is no undo. Resetting a
 * container costs only what was installed inside it.
 */
function WorkspaceActionDialog({
  pending,
  onOpenChange,
  onConfirm,
}: {
  pending: PendingAction | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (pending) setFailed(false);
  }, [pending]);

  const deleting = pending?.kind === "delete";
  const name = pending?.row.owner?.name ?? pending?.row.identity ?? "";

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      if (!(await onConfirm())) setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={pending !== null} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">
            {deleting ? `Delete ${name}?` : `Remove the container for ${name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `${pending?.row.bytes ? `${formatFileSize(pending.row.bytes)} goes with it. ` : ""}No account owns this directory, so nothing can restore it.`
              : "The files stay. Its next command builds a fresh container, and anything installed inside this one is gone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <p className="text-destructive text-xs">
            {deleting ? "The directory was not removed." : "The container was not removed."}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {deleting ? "Delete" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The volume at a glance: one bar of every owner's share, and the same colours named below. */
function VolumeSummary({
  rows,
  fills,
  used,
  total,
  free,
}: {
  rows: WorkspaceAuditRow[];
  fills: Map<string, string>;
  used: number;
  total: number;
  free: number;
}) {
  const shown = rows.slice(0, COLORED_OWNERS);
  const rest = rows.slice(COLORED_OWNERS);
  const restBytes = rest.reduce((sum, row) => sum + (row.bytes ?? 0), 0);

  return (
    <div className="border-border/50 border-b px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="console-label">Disk</span>
        <span className="text-muted-foreground truncate font-mono text-xs tabular-nums">
          {formatFileSize(free)} free of {formatFileSize(total)}
        </span>
      </div>
      <div className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full">
        {shown
          .filter((row) => (row.bytes ?? 0) > 0)
          .map((row) => (
            <div
              key={row.identity}
              className={cn("h-full", fills.get(row.identity) ?? OTHER_FILL)}
              style={{ width: `${percent(row.bytes ?? 0, used)}%` }}
              title={`${row.owner?.name ?? row.identity}: ${formatFileSize(row.bytes ?? 0)}`}
            />
          ))}
        {restBytes > 0 ? (
          <div
            className={cn("h-full", OTHER_FILL)}
            style={{ width: `${percent(restBytes, used)}%` }}
            title={`${rest.length} more: ${formatFileSize(restBytes)}`}
          />
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {shown
          .filter((row) => (row.bytes ?? 0) > 0)
          .map((row) => (
            <LegendItem
              key={row.identity}
              fill={fills.get(row.identity) ?? OTHER_FILL}
              label={row.owner?.name ?? row.identity}
              bytes={row.bytes ?? 0}
            />
          ))}
        {restBytes > 0 ? (
          <LegendItem fill={OTHER_FILL} label={`${rest.length} more`} bytes={restBytes} />
        ) : null}
      </div>
    </div>
  );
}

function LegendItem({ fill, label, bytes }: { fill: string; label: string; bytes: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className={cn("size-2 shrink-0 rounded-sm", fill)} />
      <span className="max-w-40 truncate">{label}</span>
      <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
        {formatFileSize(bytes)}
      </span>
    </span>
  );
}

/** One workspace: who owns it, how much of the volume it is, and what it is doing. */
function WorkspaceRow({
  row,
  fill,
  largest,
  onAction,
}: {
  row: WorkspaceAuditRow;
  fill: string;
  /** The biggest workspace, so every bar is measured against the same length. */
  largest: number;
  onAction: (action: PendingAction) => void;
}) {
  const orphan = row.kind === "orphan";
  const name = row.owner?.name ?? row.identity;
  // Only a deployment with a sandbox service has containers to reset.
  const hasContainer = row.container === "running" || row.container === "stopped";

  return (
    <div className="group hover:bg-accent/40 flex items-center gap-3 px-4 py-3 transition-colors duration-150">
      <Avatar className="size-8" aria-hidden>
        {row.owner?.image ? <AvatarImage src={row.owner.image} alt="" /> : null}
        <AvatarFallback className={cn(orphan && "text-amber-600 dark:text-amber-400")}>
          {orphan ? <AlertTriangle className="size-4" /> : (name[0]?.toUpperCase() ?? "?")}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("truncate text-sm font-medium", orphan && "font-mono text-xs md:text-sm")}
          >
            {name}
          </span>
          {row.running > 0 ? (
            <Badge className="bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400">
              {row.running} live
            </Badge>
          ) : null}
        </div>
        <span className="text-muted-foreground block truncate text-xs">
          {row.owner?.detail ?? "Orphaned"}
        </span>
        <div className="bg-muted mt-2 h-1 w-full max-w-56 overflow-hidden rounded-full">
          <div
            className={cn("h-full rounded-full", fill)}
            style={{ width: `${shareOfLargest(row.bytes ?? 0, largest)}%` }}
          />
        </div>
      </div>

      <div className="w-24 shrink-0 text-right md:w-28">
        <div className="truncate font-mono text-xs tabular-nums md:text-sm">
          {row.bytes === null ? "—" : formatFileSize(row.bytes)}
        </div>
        <div
          className={cn(
            "truncate text-[11px]",
            row.container === "running"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground",
          )}
        >
          {containerLabel(row.container)}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={(triggerProps) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("shrink-0", ROW_ACTION)}
              aria-label={`Actions for ${name}`}
              {...triggerProps}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          )}
        />
        {/* The popup takes the trigger's width, which wraps both labels. */}
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuItem
            disabled={!hasContainer}
            onClick={() => onAction({ kind: "container", row })}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Remove container
          </DropdownMenuItem>
          {orphan ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onAction({ kind: "delete", row })}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete directory
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function containerLabel(state: WorkspaceAuditRow["container"]): string {
  switch (state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "absent":
      return "No container";
    default:
      return "No sandbox";
  }
}

function LoadingRows() {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
      <Loader2 className="size-4 animate-spin" />
      Reading the volume…
    </div>
  );
}

function fillFor(index: number): string {
  return SEGMENT_FILLS[index] ?? OTHER_FILL;
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  // A share under a pixel stays visible.
  return Math.max((value / total) * 100, 0.3);
}

/**
 * A row's bar against the largest workspace, so owners compare with each other.
 *
 * Against the whole disk, postgres and container images would flatten every
 * owner into a sliver.
 */
function shareOfLargest(bytes: number, largest: number): number {
  if (bytes <= 0 || largest <= 0) return 0;
  return Math.max((bytes / largest) * 100, 2);
}
