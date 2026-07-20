"use client";

import { useState, useEffect, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import {
  Plug,
  Loader2,
  Plus,
  Trash2,
  CheckCircle,
  AlertCircle,
  MessageCircle,
  UserPlus,
  ExternalLink,
  MoreVertical,
  ShieldCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface TelegramAccount {
  id: string;
  enabled: boolean;
  botId: number | null;
  botUsername: string | null;
  whitelistCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WhitelistEntry {
  id: string;
  telegramUserId: string;
  displayName: string | null;
  createdAt: string;
}

type IntegrationType = "telegram";

// ─── Integration definitions (extensible) ────────────────────────────────────

const INTEGRATIONS: {
  id: IntegrationType;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}[] = [
  {
    id: "telegram",
    name: "Telegram",
    description: "Chat with Saale via your own Telegram bot",
    icon: MessageCircle,
    color: "text-sky-500",
  },
];

// ─── Main Tab Component ──────────────────────────────────────────────────────

export function IntegrationsTab() {
  const [telegramAccount, setTelegramAccount] = useState<TelegramAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Add integration dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationType | null>(null);

  // Telegram token form
  const [token, setToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSuccess, setTokenSuccess] = useState(false);

  // Whitelist
  const [whitelistOpen, setWhitelistOpen] = useState(false);
  const [whitelistEntries, setWhitelistEntries] = useState<WhitelistEntry[]>([]);
  const [whitelistLoading, setWhitelistLoading] = useState(false);
  const [newUserId, setNewUserId] = useState("");
  const [addingUser, setAddingUser] = useState(false);

  // Delete confirmation
  const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);

  const loadTelegramAccount = useCallback(async () => {
    try {
      const data = await fetchJson<{ account: TelegramAccount | null }>(
        "/api/integrations/telegram",
      );
      setTelegramAccount(data.account);
    } catch {
      setTelegramAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWhitelist = useCallback(async () => {
    setWhitelistLoading(true);
    try {
      const data = await fetchJson<{ entries: WhitelistEntry[] }>(
        "/api/integrations/telegram/whitelist",
      );
      setWhitelistEntries(data.entries);
    } catch {
      setWhitelistEntries([]);
    } finally {
      setWhitelistLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTelegramAccount();
  }, [loadTelegramAccount]);

  // Reset token form when dialog opens/closes
  useEffect(() => {
    if (!addDialogOpen) {
      setToken("");
      setTokenError(null);
      setTokenSuccess(false);
      setSelectedIntegration(null);
    }
  }, [addDialogOpen]);

  // Reset whitelist form
  useEffect(() => {
    if (!whitelistOpen) {
      setNewUserId("");
    }
  }, [whitelistOpen]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleAddIntegration = (type: IntegrationType) => {
    setSelectedIntegration(type);
  };

  const handleSaveTelegramToken = async () => {
    if (!token.trim()) {
      setTokenError("Bot token is required");
      return;
    }

    setSavingToken(true);
    setTokenError(null);
    setTokenSuccess(false);

    try {
      await postJson("/api/integrations/telegram", { token: token.trim() });
      setTokenSuccess(true);
      await loadTelegramAccount();

      // Close dialog after success and open whitelist
      setTimeout(() => {
        setAddDialogOpen(false);
        setWhitelistOpen(true);
        loadWhitelist();
      }, 800);
    } catch (err) {
      setTokenError((err as Error).message || "Failed to save Telegram bot");
    } finally {
      setSavingToken(false);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!telegramAccount) return;
    setActionLoading("toggle");
    try {
      await patchJson("/api/integrations/telegram", { enabled });
      await loadTelegramAccount();
    } catch {
      // Ignore
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteIntegration = async () => {
    setActionLoading("delete");
    try {
      await deleteJson("/api/integrations/telegram");
      await loadTelegramAccount();
    } catch {
      // Ignore
    } finally {
      setDeleteAlertOpen(false);
      setActionLoading(null);
    }
  };

  const handleAddWhitelistUser = async () => {
    if (!newUserId.trim()) return;

    setAddingUser(true);
    try {
      await postJson("/api/integrations/telegram/whitelist", {
        telegramUserId: newUserId.trim(),
      });
      setNewUserId("");
      await loadWhitelist();
    } catch {
      // Ignore — duplicate or error
    } finally {
      setAddingUser(false);
    }
  };

  const handleRemoveWhitelistUser = async (id: string) => {
    try {
      await deleteJson(`/api/integrations/telegram/whitelist/${id}`);
      await loadWhitelist();
    } catch {
      // Ignore
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
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

          {/* Active integrations */}
          {telegramAccount ? (
            <div className="space-y-3">
              <TelegramCard
                account={telegramAccount}
                actionLoading={actionLoading}
                onToggleEnabled={handleToggleEnabled}
                onOpenWhitelist={() => {
                  setWhitelistOpen(true);
                  loadWhitelist();
                }}
                onDelete={() => setDeleteAlertOpen(true)}
              />
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

      {/* Add Integration Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
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
            <div className="space-y-2 py-2">
              <Label className="text-sm">Choose an integration</Label>
              <Select onValueChange={(value) => handleAddIntegration(value as IntegrationType)}>
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
          ) : selectedIntegration === "telegram" ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-sm">Bot Token</Label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setTokenError(null);
                  }}
                  placeholder="123456:aBcDeF_gHiJkLmNoP-q"
                  className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveTelegramToken();
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  Get your bot token from{" "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    @BotFather
                    <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
                  </a>{" "}
                  on Telegram
                </p>
              </div>

              {tokenError && (
                <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm">
                  <AlertCircle className="h-4 w-4" />
                  {tokenError}
                </div>
              )}

              {tokenSuccess && (
                <div className="flex items-center gap-2 rounded-xl bg-green-500/10 px-4 py-2.5 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  Telegram bot connected successfully!
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            {selectedIntegration && (
              <Button
                className="liquid-glass-accent h-9 rounded-full text-xs font-medium"
                onClick={handleSaveTelegramToken}
                disabled={savingToken || !token.trim()}
              >
                {savingToken ? (
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

      {/* Whitelist Dialog */}
      <Dialog open={whitelistOpen} onOpenChange={setWhitelistOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Whitelisted Users
            </DialogTitle>
            <DialogDescription>
              Only whitelisted Telegram users can chat with your bot. Add your Telegram user ID to
              get started.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Add user form */}
            <div className="flex gap-2">
              <div className="flex-1 space-y-2">
                <Label className="text-xs">Telegram User ID</Label>
                <Input
                  value={newUserId}
                  onChange={(e) => setNewUserId(e.target.value)}
                  placeholder="123456789"
                  className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddWhitelistUser();
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  Find your ID by messaging{" "}
                  <a
                    href="https://t.me/userinfobot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    @userinfobot
                    <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
                  </a>
                </p>
              </div>
              <div className="flex items-end">
                <Button
                  size="sm"
                  className="liquid-glass-accent h-10 rounded-full"
                  onClick={handleAddWhitelistUser}
                  disabled={addingUser || !newUserId.trim()}
                >
                  {addingUser ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Whitelist entries */}
            {whitelistLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : whitelistEntries.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-sm">
                No users whitelisted yet
              </div>
            ) : (
              <div className="max-h-60 space-y-2 overflow-y-auto">
                {whitelistEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="liquid-glass-inner flex items-center justify-between rounded-2xl border-0 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {entry.displayName || `User ${entry.telegramUserId}`}
                      </p>
                      <p className="text-muted-foreground text-xs">ID: {entry.telegramUserId}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive/60 hover:text-destructive hover:bg-destructive/10 h-8 w-8"
                      onClick={() => handleRemoveWhitelistUser(entry.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="liquid-glass-pill h-9 rounded-full text-xs font-medium"
              onClick={() => setWhitelistOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteAlertOpen} onOpenChange={setDeleteAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Telegram Integration</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect your Telegram bot, remove the webhook, and delete all whitelist
              entries. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteIntegration}
              variant="destructive"
              disabled={actionLoading === "delete"}
            >
              {actionLoading === "delete" ? (
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

// ─── Telegram Card Component ─────────────────────────────────────────────────

function TelegramCard({
  account,
  actionLoading,
  onToggleEnabled,
  onOpenWhitelist,
  onDelete,
}: {
  account: TelegramAccount;
  actionLoading: string | null;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenWhitelist: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="liquid-glass-inner rounded-2xl border-0 p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-sky-500/10 p-2.5">
            <MessageCircle className="h-5 w-5 text-sky-500" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">Telegram Bot</h4>
              {account.botUsername && (
                <Badge variant="secondary" className="rounded-full">
                  @{account.botUsername}
                </Badge>
              )}
              {!account.enabled && (
                <Badge variant="outline" className="rounded-full">
                  Disabled
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {account.whitelistCount} whitelisted user
              {account.whitelistCount !== 1 ? "s" : ""}
              {account.enabled ? " · Bot is active" : " · Bot is disabled"}
            </p>
            <p className="text-muted-foreground text-xs">
              Added {new Date(account.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Enable</span>
            <Switch
              checked={account.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={actionLoading === "toggle"}
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!!actionLoading}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenWhitelist}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Manage Whitelist
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove Integration
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
