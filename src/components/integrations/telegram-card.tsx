"use client";

import { useState } from "react";
import {
  MessageCircle,
  Trash2,
  MoreVertical,
  ShieldCheck,
  UserPlus,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TelegramAccount, WhitelistEntry } from "@/hooks/use-telegram-integration";

/**
 * Telegram integration card with embedded whitelist management.
 *
 * Receives all data and actions as props from the parent to avoid
 * duplicate API calls. Manages only its own local UI state (dialogs).
 */
export function TelegramCard({
  account,
  onToggleEnabled,
  onDelete,
  actionLoading,
  whitelistEntries,
  whitelistLoading,
  newUserId,
  onNewUserIdChange,
  addingUser,
  onAddUser,
  onRemoveUser,
}: {
  account: TelegramAccount;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  actionLoading: string | null;
  whitelistEntries: WhitelistEntry[];
  whitelistLoading: boolean;
  newUserId: string;
  onNewUserIdChange: (value: string) => void;
  addingUser: boolean;
  onAddUser: () => void;
  onRemoveUser: (id: string) => void;
}) {
  const [whitelistOpen, setWhitelistOpen] = useState(false);

  return (
    <>
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!!actionLoading}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setWhitelistOpen(true)}>
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

      {/* Whitelist Dialog — owned by this card, data from parent */}
      <WhitelistDialog
        open={whitelistOpen}
        onOpenChange={setWhitelistOpen}
        entries={whitelistEntries}
        loading={whitelistLoading}
        newUserId={newUserId}
        onNewUserIdChange={onNewUserIdChange}
        addingUser={addingUser}
        onAddUser={onAddUser}
        onRemoveUser={onRemoveUser}
      />
    </>
  );
}

// ─── Whitelist Dialog ────────────────────────────────────────────────────────

function WhitelistDialog({
  open,
  onOpenChange,
  entries,
  loading,
  newUserId,
  onNewUserIdChange,
  addingUser,
  onAddUser,
  onRemoveUser,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: WhitelistEntry[];
  loading: boolean;
  newUserId: string;
  onNewUserIdChange: (value: string) => void;
  addingUser: boolean;
  onAddUser: () => void;
  onRemoveUser: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Whitelisted Users
          </DialogTitle>
          <DialogDescription>
            Only whitelisted Telegram users can chat with your bot. Add your Telegram user ID to get
            started.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Add user form */}
          <div className="flex gap-2">
            <div className="flex-1 space-y-2">
              <Label className="text-xs">Telegram User ID</Label>
              <Input
                value={newUserId}
                onChange={(e) => onNewUserIdChange(e.target.value)}
                placeholder="123456789"
                className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAddUser();
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
                onClick={onAddUser}
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
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center text-sm">
              No users whitelisted yet
            </div>
          ) : (
            <div className="max-h-60 space-y-2 overflow-y-auto">
              {entries.map((entry) => (
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
                    onClick={() => onRemoveUser(entry.id)}
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
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
