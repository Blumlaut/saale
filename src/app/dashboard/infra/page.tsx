"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { MachineList } from "@/components/infra/machine-list";
import { MachineDialog } from "@/components/infra/machine-dialog";

export interface InfraMachine {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
}

export default function InfraPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [editingMachine, setEditingMachine] = useState<InfraMachine | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleCreated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleEdit = useCallback((machine: InfraMachine) => {
    setEditingMachine(machine);
    setShowDialog(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setShowDialog(open);
    if (!open) setEditingMachine(null);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">
            Infrastructure
          </h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">
            Remote machines the agent can manage via SSH
          </p>
        </div>

        <Button
          variant="default"
          size="icon"
          className="h-8 w-8 md:h-9 md:w-auto md:px-3"
          onClick={() => setShowDialog(true)}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">Add Machine</span>
        </Button>
      </div>

      {/* Machine List */}
      <MachineList key={refreshKey} onEdit={handleEdit} onRefresh={handleCreated} />

      {/* Add/Edit Dialog */}
      <MachineDialog
        open={showDialog}
        onOpenChange={handleDialogClose}
        onSuccess={handleCreated}
        machine={editingMachine}
      />
    </div>
  );
}
