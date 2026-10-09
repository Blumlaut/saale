"use client";

import { useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, CheckCircle, AlertCircle, Plug, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useGitHubIntegration } from "@/hooks/use-github-integration";
import {
  TelegramCard,
  TelegramLinkDialog,
  TelegramLinkPanel,
} from "@/components/integrations/telegram-card";
import { GitHubCard } from "@/components/integrations/github-card";

/** Delete confirmation descriptions per integration */
const DELETE_DESCRIPTIONS: Record<IntegrationId, string> = {
  telegram:
    "This unlinks your Telegram account. Nothing is sent to Telegram, and you can link again at any time.",
  github:
    "This will disconnect your GitHub account and remove the stored token. This cannot be undone.",
};

export function IntegrationsTab() {
  const telegram = useTelegramIntegration();
  const github = useGitHubIntegration();

  const initialLoading = telegram.loading || github.loading;

  // Add integration dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationId | null>(null);

  // Delete confirmation
  const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);
  const [deleteIntegrationId, setDeleteIntegrationId] = useState<IntegrationId | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Relink dialog — opening it discards any code minted for the last attempt
  const [relinkOpen, setRelinkOpen] = useState(false);

  // Reset forms when dialog closes
  const closeAddDialog = useCallback(() => {
    setAddDialogOpen(false);
    telegram.resetLinkCode();
    github.resetTokenForm();
    setSelectedIntegration(null);
  }, [telegram, github]);

  // ─── Handlers ─────────────────────────────────────────────────────

  const handleSaveGitHub = useCallback(() => {
    github.saveToken(() => {
      setTimeout(() => {
        closeAddDialog();
      }, 800);
    });
  }, [github, closeAddDialog]);

  const handleDelete = useCallback(async () => {
    if (!deleteIntegrationId) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/integrations/${deleteIntegrationId}`);
      if (deleteIntegrationId === "telegram") {
        await telegram.loadIntegration();
      } else {
        await github.loadAccount();
      }
    } catch (err) {
      console.error(`Failed to delete ${deleteIntegrationId} integration:`, err);
    } finally {
      setDeleting(false);
      setDeleteAlertOpen(false);
      setDeleteIntegrationId(null);
    }
  }, [deleteIntegrationId, telegram, github]);

  const hasAnyIntegration = !!telegram.link || !!github.account;

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
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Plug className="h-5 w-5" />
                Integrations
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Connect external services to your Saale instance
              </p>
            </div>
            <Button
              size="sm"
              className="liquid-glass-accent rounded-full"
              onClick={() => setAddDialogOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Integration
            </Button>
          </div>

          {/* Active integrations — data passed as props, no duplicate hooks */}
          {hasAnyIntegration ? (
            <div className="space-y-3">
              {telegram.link && (
                <TelegramCard
                  link={telegram.link}
                  botUsername={telegram.bot.username}
                  unlinking={telegram.unlinking}
                  onRelink={() => {
                    telegram.resetLinkCode();
                    setRelinkOpen(true);
                  }}
                  onUnlink={() => {
                    setDeleteIntegrationId("telegram");
                    setDeleteAlertOpen(true);
                  }}
                />
              )}
              {github.account && (
                <GitHubCard
                  account={github.account}
                  actionLoading={github.actionLoading}
                  onToggleEnabled={github.toggleEnabled}
                  onDelete={() => {
                    setDeleteIntegrationId("github");
                    setDeleteAlertOpen(true);
                  }}
                />
              )}
            </div>
          ) : (
            <div className="liquid-glass-inner border-border/30 flex flex-col items-center rounded-2xl border border-dashed p-8 text-center">
              <Plug className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No integrations connected. Add one to get started.
              </p>
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      {/* Add Integration Dialog — driven by registry */}
      <AddIntegrationDialog
        open={addDialogOpen}
        onOpenChange={closeAddDialog}
        selectedIntegration={selectedIntegration}
        onSelectIntegration={setSelectedIntegration}
        telegram={telegram}
        github={github}
        onSaveGitHub={handleSaveGitHub}
      />

      {/* Relink — same panel, without going through Add Integration */}
      <TelegramLinkDialog
        open={relinkOpen}
        onOpenChange={setRelinkOpen}
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

// ─── Add Integration Dialog (driven by registry) ─────────────────────────────

function AddIntegrationDialog({
  open,
  onOpenChange,
  selectedIntegration,
  onSelectIntegration,
  telegram,
  github,
  onSaveGitHub,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIntegration: IntegrationId | null;
  onSelectIntegration: (id: IntegrationId) => void;
  telegram: ReturnType<typeof useTelegramIntegration>;
  github: ReturnType<typeof useGitHubIntegration>;
  onSaveGitHub: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Integration</DialogTitle>
          <DialogDescription>
            {selectedIntegration
              ? `Configure your ${INTEGRATIONS.find((i) => i.id === selectedIntegration)?.name} connection`
              : "Select an integration to add"}
          </DialogDescription>
        </DialogHeader>

        {!selectedIntegration ? (
          /* Integration selector — driven by registry */
          <div className="space-y-2 py-2">
            <Label className="text-sm">Choose an integration</Label>
            <Select onValueChange={(value) => onSelectIntegration(value as IntegrationId)}>
              <SelectTrigger className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {INTEGRATIONS.map((integration) => (
                  <SelectItem key={integration.id} value={integration.id}>
                    <div className="flex items-center gap-2">
                      <integration.icon className="h-4 w-4" />
                      {integration.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          /* Config form — per-integration */
          <>
            {selectedIntegration === "telegram" && (
              <TelegramLinkPanel
                bot={telegram.bot}
                linkCode={telegram.linkCode}
                linking={telegram.linking}
                linkError={telegram.linkError}
                linked={!!telegram.link}
                onCreateCode={telegram.createLinkCode}
              />
            )}

            {selectedIntegration === "github" && (
              <IntegrationConfigForm
                label="Personal Access Token"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                helpText={
                  <>
                    Create a token at{" "}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      github.com/settings/tokens
                      <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
                    </a>{" "}
                    with <code className="bg-muted/50 rounded px-1 text-xs">repo</code> scope
                  </>
                }
                value={github.token}
                onChange={github.setToken}
                error={github.tokenError}
                success={github.tokenSuccess}
                successMessage="GitHub connected successfully!"
                onSave={onSaveGitHub}
              />
            )}
          </>
        )}

        <DialogFooter>
          {selectedIntegration === "github" && (
            <Button
              className="liquid-glass-accent h-9 rounded-full text-xs font-medium"
              onClick={onSaveGitHub}
              disabled={github.savingToken || !github.token.trim()}
            >
              {github.savingToken ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Connecting...
                </>
              ) : (
                "Connect"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Shared Config Form (used by all token-based integrations) ────────────────

function IntegrationConfigForm({
  label,
  placeholder,
  helpText,
  value,
  onChange,
  error,
  success,
  successMessage,
  onSave,
}: {
  label: string;
  placeholder: string;
  helpText: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  success: boolean;
  successMessage: string;
  onSave: () => void;
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label className="text-sm">{label}</Label>
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
        />
        <p className="text-muted-foreground text-xs">{helpText}</p>
      </div>

      {error && (
        <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-xl bg-green-500/10 px-4 py-2.5 text-sm text-green-600 dark:text-green-400">
          <CheckCircle className="h-4 w-4" />
          {successMessage}
        </div>
      )}
    </div>
  );
}
