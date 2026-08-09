"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { Page, PageHeader, PageScroll } from "@/components/layout/page";
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
    <Page>
      {/* Header — pinned, never scrolls */}
      <PageHeader
        title="Infrastructure"
        description="Remote machines the agent can manage via SSH"
        actions={
          <Button
            variant="default"
            size="icon"
            className="h-8 w-8 md:h-9 md:w-auto md:px-3"
            onClick={() => setShowDialog(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">Add Machine</span>
          </Button>
        }
      />

      {/* Machine List — scrolls internally */}
      <PageScroll>
        <MachineList key={refreshKey} onEdit={handleEdit} onRefresh={handleCreated} />
      </PageScroll>

      {/* Add/Edit Dialog */}
      <MachineDialog
        open={showDialog}
        onOpenChange={handleDialogClose}
        onSuccess={handleCreated}
        machine={editingMachine}
      />
    </Page>
  );
}
