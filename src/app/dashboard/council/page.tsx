"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Page } from "@/components/layout/page";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { CouncilDialog } from "@/components/council/council-dialog";
import { CouncilStatusBadge } from "@/components/council/run-status";
import { deleteJson, fetchJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { cn, ROW_ACTION } from "@/lib/utils";
import type { CouncilDetail, CouncilSummary } from "@/types/council";
import { FolderOpen, Loader2, MoreVertical, Pencil, Plus, Trash2, Users } from "lucide-react";

/**
 * The council list. a single full-height panel whose first row is the toolbar.
 * There is no page title; the nav names the page.
 */
export default function CouncilPage() {
  const router = useRouter();
  const [councils, setCouncils] = useState<CouncilSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CouncilDetail | null>(null);
  const [deleting, setDeleting] = useState<CouncilSummary | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ councils: CouncilSummary[] }>("/api/council");
      setCouncils(data.councils);
      setError("");
    } catch (err) {
      console.error("Failed to load councils:", err);
      setError(err instanceof Error ? err.message : "Could not load councils.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback(async (id: string) => {
    try {
      const data = await fetchJson<{ council: CouncilDetail }>(`/api/council/${id}`);
      setEditing(data.council);
      setDialogOpen(true);
    } catch (err) {
      console.error("Failed to load the council for editing:", err);
      setError(err instanceof Error ? err.message : "Could not open the council.");
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await deleteJson(`/api/council/${deleting.id}`);
      setCouncils((prev) => prev.filter((council) => council.id !== deleting.id));
      setDeleting(null);
    } catch (err) {
      console.error("Failed to delete a council:", err);
      setError(err instanceof Error ? err.message : "Could not delete the council.");
    } finally {
      setDeletePending(false);
    }
  }, [deleting]);

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          {/* Toolbar. functional context left, actions right, icon-only on mobile */}
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 md:px-6">
            <span className="console-label min-w-0 truncate">
              {councils.length === 0 ? "Councils" : `${councils.length} councils`}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void load()}
                aria-label="Refresh councils"
              >
                <Loader2 className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={openCreate}
                className="h-8 gap-1.5 md:h-9"
                aria-label="New council"
              >
                <Plus className="h-4 w-4" />
                <span className="hidden md:inline">New council</span>
              </Button>
            </div>
          </div>

          {/* The list scrolls here. the only scroll region */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
                <p className="text-destructive text-sm">{error}</p>
                <p className="text-muted-foreground text-xs">
                  The council module is available only to admins, and only when it is enabled.
                </p>
              </div>
            ) : councils.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-4 py-14 text-center">
                <Users className="text-muted-foreground h-5 w-5" />
                <p className="text-muted-foreground text-sm">No councils yet.</p>
                <p className="text-muted-foreground max-w-sm text-xs">
                  Create one to gather a few named agents around a goal and watch them work.
                </p>
                <Button size="sm" onClick={openCreate} className="mt-3">
                  <Plus className="h-4 w-4" />
                  New council
                </Button>
              </div>
            ) : (
              councils.map((council, index) => (
                <div key={council.id}>
                  <div className="group hover:bg-accent/60 flex items-center gap-3 px-4 py-3 transition-colors md:px-6">
                    <Link
                      href={`/dashboard/council/${council.id}`}
                      className="min-w-0 flex-1"
                      aria-label={`Open ${council.name}`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{council.name}</span>
                        <CouncilStatusBadge status={council.status} />
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span>
                          {council.enabledMemberCount} of {council.memberCount} member
                          {council.memberCount === 1 ? "" : "s"}
                        </span>
                        <span aria-hidden>·</span>
                        <span>
                          {council.lastRunAt
                            ? `Last run ${formatRelativeDate(council.lastRunAt)}`
                            : "Never run"}
                        </span>
                      </div>
                    </Link>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={(triggerProps) => (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={cn("shrink-0", ROW_ACTION)}
                            aria-label={`Actions for ${council.name}`}
                            {...triggerProps}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        )}
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void openEdit(council.id)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => router.push(`/dashboard/council/${council.id}/files`)}
                        >
                          <FolderOpen className="mr-2 h-3.5 w-3.5" />
                          Files
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleting(council)}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {index < councils.length - 1 && <Separator />}
                </div>
              ))
            )}
          </div>
        </GlassPanel>
      </div>

      <CouncilDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        council={editing}
        onSaved={() => void load()}
      />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this council?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="break-all">{deleting?.name}</span> and its room history, runs and
              member transcripts will be deleted. Its isolated workspace is removed too. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletePending}
              onClick={() => void confirmDelete()}
            >
              {deletePending && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
