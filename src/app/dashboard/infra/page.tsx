"use client";

import { useState, useCallback } from "react";
import { Page } from "@/components/layout/page";
import { MachineList } from "@/components/infra/machine-list";
import { MachineDialog } from "@/components/infra/machine-dialog";
import { MachineNotesDialog } from "@/components/infra/machine-notes-dialog";

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
  const [notesMachine, setNotesMachine] = useState<InfraMachine | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleCreated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleEdit = useCallback((machine: InfraMachine) => {
    setEditingMachine(machine);
    setShowDialog(true);
  }, []);

  const handleOpenNotes = useCallback((machine: InfraMachine) => {
    setNotesMachine(machine);
  }, []);

  const handleNotesClose = useCallback((open: boolean) => {
    if (!open) setNotesMachine(null);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setShowDialog(open);
    if (!open) setEditingMachine(null);
  }, []);

  return (
    <Page className="gap-0">
      {/* Machine list — fills height, owns its toolbar, scrolls internally */}
      <div className="min-h-0 flex-1">
        <MachineList
          key={refreshKey}
          onAdd={() => setShowDialog(true)}
          onEdit={handleEdit}
          onOpenNotes={handleOpenNotes}
          onRefresh={handleCreated}
        />
      </div>

      {/* Add/Edit Dialog */}
      <MachineDialog
        open={showDialog}
        onOpenChange={handleDialogClose}
        onSuccess={handleCreated}
        machine={editingMachine}
      />

      {/* Notes Dialog */}
      <MachineNotesDialog
        open={!!notesMachine}
        onOpenChange={handleNotesClose}
        machine={notesMachine}
        onSuccess={handleCreated}
      />
    </Page>
  );
}
