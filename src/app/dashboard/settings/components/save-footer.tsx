"use client";

import { Button } from "@/components/ui/button";
import { GlassPanelFooter } from "@/components/ui/glass-panel";
import { Loader2, CheckCircle, AlertCircle } from "lucide-react";

interface SaveFooterProps {
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => void;
}

export function SaveFooter({ saving, saveStatus, onSave }: SaveFooterProps) {
  return (
    <GlassPanelFooter>
      <div>
        {saveStatus === "success" && (
          <span className="flex items-center gap-1 text-sm text-emerald-500">
            <CheckCircle className="h-4 w-4" />
            Saved
          </span>
        )}
        {saveStatus === "error" && (
          <span className="flex items-center gap-1 text-sm text-red-500">
            <AlertCircle className="h-4 w-4" />
            Failed to save
          </span>
        )}
        {saveStatus === "idle" && (
          <span className="text-muted-foreground text-sm">Changes are applied when you save</span>
        )}
      </div>
      <Button onClick={onSave} disabled={saving}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {saving ? "Saving" : "Save"}
      </Button>
    </GlassPanelFooter>
  );
}
