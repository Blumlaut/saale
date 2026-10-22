"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Server,
  Pencil,
  Trash2,
  Plug,
  Loader2,
  FileText,
  Plus,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson, deleteJson, postJson } from "@/lib/http";
import type { InfraMachine } from "@/app/dashboard/infra/page";

interface MachineListProps {
  onAdd: () => void;
  onEdit: (machine: InfraMachine) => void;
  onOpenNotes: (machine: InfraMachine) => void;
  onRefresh: () => void;
}

export function MachineList({ onAdd, onEdit, onOpenNotes, onRefresh }: MachineListProps) {
  const [machines, setMachines] = useState<InfraMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ machines: InfraMachine[] }>("/api/infra/machines")
      .then((data) => {
        setMachines(data.machines ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const testConnection = async (id: string) => {
    setTestingId(id);
    setTestResults((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

    try {
      const data = await postJson<{ ok: boolean; message: string; hostname?: string | null }>(
        "/api/infra/machines/test-connection",
        { id },
      );
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: data.ok,
          message: data.hostname ? `${data.message} (${data.hostname})` : data.message,
        },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, message: err instanceof Error ? err.message : "Connection failed" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this machine and all its notes?")) return;

    setDeletingId(id);
    try {
      await deleteJson(`/api/infra/machines/${id}`);
      setMachines((prev) => prev.filter((m) => m.id !== id));
      onRefresh();
    } catch (err) {
      console.error("Failed to delete machine:", err);
    } finally {
      setDeletingId(null);
    }
  };

  const toolbar = (
    <div className="border-border/30 flex shrink-0 items-center justify-end border-b px-4 py-2">
      <Button variant="default" size="icon" className="h-8 w-8 md:w-auto md:px-3" onClick={onAdd}>
        <Plus className="h-4 w-4" />
        <span className="hidden md:inline">Add Machine</span>
      </Button>
    </div>
  );

  if (loading) {
    return (
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        {toolbar}
        <div className="flex flex-1 items-center justify-center py-12">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      </GlassPanel>
    );
  }

  if (machines.length === 0) {
    return (
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        {toolbar}
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <Server className="text-muted-foreground mb-3 h-8 w-8" />
          <h3 className="text-sm font-medium">No machines registered</h3>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Add a remote machine to let the agent connect via SSH and run commands, manage files,
            and maintain notes.
          </p>
        </div>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      {toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {machines.map((machine, i) => {
          const isTesting = testingId === machine.id;
          const testResult = isTesting ? undefined : testResults[machine.id];

          return (
            <div key={machine.id} className={i > 0 ? "border-border/30 border-t" : undefined}>
              <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                {/* Machine info */}
                <div className="flex items-start gap-3">
                  <div className="bg-muted/50 mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                    <Server className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{machine.name}</span>
                      <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
                        {machine.authMethod === "key" ? "SSH Key" : "Password"}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                      <span>
                        {machine.username}@{machine.host}
                      </span>
                      {machine.port !== 22 && <span>:{machine.port}</span>}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5">
                  {/* Notes */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-7 gap-1", machine.noteCount > 0 && "w-auto min-w-7 px-1.5")}
                    onClick={() => onOpenNotes(machine)}
                    title="View notes"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {machine.noteCount > 0 && (
                      <span className="text-[10px] font-medium">{machine.noteCount}</span>
                    )}
                  </Button>

                  {/* Test connection */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => testConnection(machine.id)}
                    disabled={testingId === machine.id}
                    title="Test connection"
                  >
                    {testingId === machine.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plug className="h-3.5 w-3.5" />
                    )}
                  </Button>

                  {/* Edit */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onEdit(machine)}
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>

                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive h-7 w-7"
                    onClick={() => handleDelete(machine.id)}
                    disabled={deletingId !== null}
                    title="Remove"
                  >
                    {deletingId === machine.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Connection status: neutral while testing, semantic once it settles */}
              {isTesting ? (
                <div className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 border-border/30 flex items-center gap-2 border-t px-4 py-2 text-xs duration-200">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span className="console-label">Testing connection</span>
                </div>
              ) : testResult ? (
                <div
                  className={cn(
                    "animate-in fade-in slide-in-from-bottom-1 border-border/30 flex items-center gap-2 border-t px-4 py-2 text-xs duration-200",
                    testResult.ok
                      ? "bg-emerald-500/5 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400"
                      : "bg-destructive/5 text-destructive",
                  )}
                >
                  {testResult.ok ? (
                    <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 break-words">{testResult.message}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}
