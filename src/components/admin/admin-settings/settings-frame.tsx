"use client";

import { Loader2, Save } from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Page, PageAction, PageActions, PageScroll, PageStatus } from "@/components/layout/page";
import type { AdminSaveStatus } from "./use-admin-settings";

/**
 * An admin settings page, with its Save row as the panel's first row.
 */
export function AdminSettingsFrame({
  status,
  saving,
  loading,
  onSave,
  children,
}: {
  status: AdminSaveStatus;
  saving: boolean;
  /** The page's values are still loading. */
  loading: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions>
          <PageStatus status={status} />
          <PageAction icon={Save} label="Save" busy={saving} disabled={loading} onClick={onSave} />
        </PageActions>

        <PageScroll>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : (
            children
          )}
        </PageScroll>
      </GlassPanel>
    </Page>
  );
}
