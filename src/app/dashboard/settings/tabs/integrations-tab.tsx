"use client";

import { useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Loader2, Plug } from "lucide-react";
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
import { deleteJson } from "@/lib/http";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationId } from "@/lib/integrations/types";
import { useTelegramIntegration } from "@/hooks/use-telegram-integration";
import { TelegramBox, TelegramLinkDialog } from "@/components/integrations/telegram-card";
import { SandboxEnvCard } from "@/components/integrations/sandbox-env-card";
import { McpTab } from "./mcp-tab";

/** Delete confirmation descriptions per integration */
const DELETE_DESCRIPTIONS: Record<IntegrationId, string> = {
  telegram:
    "This unlinks your Telegram account. Nothing is sent to Telegram, and you can link again at any time.",
};

export function IntegrationsTab() {
  const telegram = useTelegramIntegration();

  const initialLoading = telegram.loading;

  // Link dialog
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);

  // Delete confirmation
  const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);
  const [deleteIntegrationId, setDeleteIntegrationId] = useState<IntegrationId | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ─── Handlers ─────────────────────────────────────────────────────

  const openTelegramDialog = useCallback(() => {
    // Opening it discards any code minted for the last attempt
    telegram.resetLinkCode();
    setTelegramDialogOpen(true);
  }, [telegram]);

  const handleDelete = useCallback(async () => {
    if (!deleteIntegrationId) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/integrations/${deleteIntegrationId}`);
      await telegram.loadIntegration();
    } catch (err) {
      console.error(`Failed to delete ${deleteIntegrationId} integration:`, err);
    } finally {
      setDeleting(false);
      setDeleteAlertOpen(false);
      setDeleteIntegrationId(null);
    }
  }, [deleteIntegrationId, telegram]);

  // ─── Render ───────────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <GlassPanel className="border-0">
        <GlassPanelContent className="space-y-6">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Plug className="h-5 w-5" />
              Integrations
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Connect external services to your Saale instance
            </p>
          </div>

          {/* One box per integration. connected status or a button to connect */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TelegramBox
              link={telegram.link}
              bot={telegram.bot}
              chats={telegram.chats}
              unlinking={telegram.unlinking}
              removingChatId={telegram.removingChatId}
              onRemoveChat={telegram.removeChat}
              onLink={openTelegramDialog}
              onUnlink={() => {
                setDeleteIntegrationId("telegram");
                setDeleteAlertOpen(true);
              }}
            />
            <SandboxEnvCard />
          </div>
        </GlassPanelContent>
      </GlassPanel>

      <McpTab />

      {/* Link / relink. same dialog, the panel adapts to the current state */}
      <TelegramLinkDialog
        open={telegramDialogOpen}
        onOpenChange={setTelegramDialogOpen}
        bot={telegram.bot}
        linkCode={telegram.linkCode}
        linking={telegram.linking}
        linkError={telegram.linkError}
        linked={!!telegram.link}
        onCreateCode={telegram.createLinkCode}
        onDone={telegram.loadIntegration}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={deleteAlertOpen} onOpenChange={setDeleteAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteIntegrationId
                ? `Remove ${INTEGRATIONS.find((i) => i.id === deleteIntegrationId)?.name} Integration`
                : "Remove Integration"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteIntegrationId ? DELETE_DESCRIPTIONS[deleteIntegrationId] : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} variant="destructive" disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
