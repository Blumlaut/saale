"use client";

import { useEffect, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Server,
  Pencil,
  Trash2,
  Plug,
  Loader2,
  FileText,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson, deleteJson, postJson } from "@/lib/http";
import type { InfraMachine } from "@/app/dashboard/infra/page";

interface MachineListProps {
  onEdit: (machine: InfraMachine) => void;
  onOpenNotes: (machine: InfraMachine) => void;
  onRefresh: () => void;
}

export function MachineList({ onEdit, onOpenNotes, onRefresh }: MachineListProps) {
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
    setTestResults((prev) => ({ ...prev, [id]: { ok: false, message: "Testing..." } }));

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

  if (loading) {
    return (
      <GlassPanel>
        <GlassPanelContent className="flex items-center justify-center py-12">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </GlassPanelContent>
      </GlassPanel>
    );
  }

  if (machines.length === 0) {
    return (
      <GlassPanel>
        <GlassPanelContent className="flex flex-col items-center justify-center py-12 text-center">
          <Server className="text-muted-foreground mb-3 h-8 w-8" />
          <h3 className="text-sm font-medium">No machines registered</h3>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Add a remote machine to let the agent connect via SSH and run commands, manage files,
            and maintain notes.
          </p>
        </GlassPanelContent>
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-2">
      {machines.map((machine) => {
        const testResult = testResults[machine.id];

        return (
          <GlassPanel key={machine.id}>
            <GlassPanelContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
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
                  disabled={testingId !== null}
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
            </GlassPanelContent>

            {/* Test result */}
            {testResult && (
              <div
                className={cn(
                  "flex items-center gap-2 border-t px-4 py-2 text-xs",
                  testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                )}
              >
                {testResult.ok ? (
                  <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}
          </GlassPanel>
        );
      })}
    </div>
  );
}
