"use client";

import { useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Plug } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { deleteJson } from "@/lib/http";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationId } from "@/lib/integrations/types";
import { useTelegramIntegration } from "@/hooks/use-telegram-integration";
import { TelegramBox, TelegramLinkDialog } from "@/components/integrations/telegram-card";
import { GithubCard } from "@/components/integrations/github-card";
import { SandboxEnvCard } from "@/components/integrations/sandbox-env-card";
import { McpPanel } from "../components/mcp-panel";
import { SkillsPanel } from "@/components/skills/skills-panel";
import { useUserSettings } from "../components/user-settings-provider";

/** Delete confirmation descriptions per integration */
const DELETE_DESCRIPTIONS: Record<IntegrationId, string> = {
  telegram:
    "This unlinks your Telegram account. Nothing is sent to Telegram, and you can link again at any time.",
};

export function IntegrationsSection() {
  const telegram = useTelegramIntegration();
  const { settings, update, saveState } = useUserSettings();

  // Link dialog
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);

  const [deleteIntegrationId, setDeleteIntegrationId] = useState<IntegrationId | null>(null);

  // ─── Handlers ─────────────────────────────────────────────────────

  const openTelegramDialog = useCallback(() => {
    // Opening it discards any code minted for the last attempt
    telegram.resetLinkCode();
    setTelegramDialogOpen(true);
  }, [telegram]);

  const handleDelete = useCallback(async () => {
    if (!deleteIntegrationId) return;
    try {
      await deleteJson(`/api/integrations/${deleteIntegrationId}`);
      await telegram.loadIntegration();
    } catch (err) {
      console.error(`Failed to delete ${deleteIntegrationId} integration:`, err);
      throw err;
    }
  }, [deleteIntegrationId, telegram]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <GlassPanel className="border-0">
        <GlassPanelContent className="space-y-6">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Plug className="h-5 w-5" />
              Integrations &amp; MCP
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
              loading={telegram.loading}
              unlinking={telegram.unlinking}
              removingChatId={telegram.removingChatId}
              onRemoveChat={telegram.removeChat}
              onLink={openTelegramDialog}
              toolNotices={settings?.telegramToolNotices ?? false}
              noticesDisabled={!settings}
              noticesSaving={saveState === "saving"}
              onToolNoticesChange={(on) => update({ telegramToolNotices: on })}
              onUnlink={() => setDeleteIntegrationId("telegram")}
            />
            <SandboxEnvCard />
            <GithubCard />
          </div>
        </GlassPanelContent>
      </GlassPanel>

      <McpPanel />

      <SkillsPanel />

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

      <ConfirmDialog
        open={deleteIntegrationId !== null}
        title={
          deleteIntegrationId
            ? `Remove ${INTEGRATIONS.find((i) => i.id === deleteIntegrationId)?.name} integration?`
            : "Remove integration?"
        }
        description={deleteIntegrationId ? DELETE_DESCRIPTIONS[deleteIntegrationId] : ""}
        confirmLabel="Remove"
        busyLabel="Removing…"
        onOpenChange={(open) => !open && setDeleteIntegrationId(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
