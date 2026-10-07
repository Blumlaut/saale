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
  BellRing,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  TelegramAccount,
  TelegramChatInfo,
  TelegramNotifyChat,
  WhitelistEntry,
} from "@/hooks/use-telegram-integration";

/** Select value meaning "resolve the chat automatically". */
const AUTOMATIC_CHAT = "automatic";

/** How the current notification chat was chosen, in the user's words. */
const NOTIFY_SOURCE_LABELS: Record<TelegramNotifyChat["source"], string> = {
  pinned: "pinned",
  private: "automatic — most recent private chat",
  whitelist: "automatic — whitelisted user",
};

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
  onOpenWhitelist,
  newUserId,
  onNewUserIdChange,
  addingUser,
  onAddUser,
  onRemoveUser,
  notifyChats,
  notifyChatsLoading,
  savingNotifyChat,
  onOpenNotifyChats,
  onSetNotifyChat,
}: {
  account: TelegramAccount;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  actionLoading: string | null;
  whitelistEntries: WhitelistEntry[];
  whitelistLoading: boolean;
  /** Called right before the whitelist dialog opens — fetches fresh entries. */
  onOpenWhitelist: () => void;
  newUserId: string;
  onNewUserIdChange: (value: string) => void;
  addingUser: boolean;
  onAddUser: () => void;
  onRemoveUser: (id: string) => void;
  /** Chats the bot can send to, for the notification-chat picker. */
  notifyChats: TelegramChatInfo[];
  notifyChatsLoading: boolean;
  savingNotifyChat: boolean;
  /** Called right before the notification-chat dialog opens — fetches fresh chats. */
  onOpenNotifyChats: () => void;
  /** Pin a chat, or pass null to go back to automatic resolution. */
  onSetNotifyChat: (chatId: string | null) => void;
}) {
  const [whitelistOpen, setWhitelistOpen] = useState(false);
  const [notifyChatOpen, setNotifyChatOpen] = useState(false);

  const handleWhitelistOpenChange = (open: boolean) => {
    setWhitelistOpen(open);
    // Fetch fresh entries every time the dialog opens — the whitelist can
    // change from elsewhere (webhook auto-whitelist, another device), so we
    // must not show stale (possibly empty) data.
    if (open) onOpenWhitelist();
  };

  const handleNotifyChatOpenChange = (open: boolean) => {
    setNotifyChatOpen(open);
    // Same reason as the whitelist: the reachable chats change as soon as the
    // user messages the bot, so a cached list would be wrong.
    if (open) onOpenNotifyChats();
  };

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
                <DropdownMenuItem onClick={() => handleNotifyChatOpenChange(true)}>
                  <BellRing className="mr-2 h-4 w-4" />
                  Notification Chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleWhitelistOpenChange(true)}>
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
        onOpenChange={handleWhitelistOpenChange}
        entries={whitelistEntries}
        loading={whitelistLoading}
        newUserId={newUserId}
        onNewUserIdChange={onNewUserIdChange}
        addingUser={addingUser}
        onAddUser={onAddUser}
        onRemoveUser={onRemoveUser}
      />

      {/* Notification chat picker — same data-from-parent pattern */}
      <NotifyChatDialog
        open={notifyChatOpen}
        onOpenChange={handleNotifyChatOpenChange}
        account={account}
        chats={notifyChats}
        loading={notifyChatsLoading}
        saving={savingNotifyChat}
        onSelect={onSetNotifyChat}
      />
    </>
  );
}

// ─── Notification Chat Dialog ────────────────────────────────────────────────

/**
 * Pick the chat proactive messages go to.
 *
 * Selecting saves immediately — there is one value, and the dialog shows the
 * resolved result right below the picker, so a separate Save step would only
 * add a way to lose the change.
 */
function NotifyChatDialog({
  open,
  onOpenChange,
  account,
  chats,
  loading,
  saving,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: TelegramAccount;
  chats: TelegramChatInfo[];
  loading: boolean;
  saving: boolean;
  onSelect: (chatId: string | null) => void;
}) {
  const selected = account.notifyChatId ?? AUTOMATIC_CHAT;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="h-5 w-5" />
            Notification Chat
          </DialogTitle>
          <DialogDescription>
            Where Saale sends you things outside a conversation — reminders, finished jobs and agent
            messages. Automatic picks your most recent private chat.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-xs">Send notifications to</Label>
            <Select
              value={selected}
              onValueChange={(value) => onSelect(!value || value === AUTOMATIC_CHAT ? null : value)}
              disabled={saving || loading}
            >
              <SelectTrigger className="liquid-glass-inner w-full rounded-full border-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTOMATIC_CHAT}>Automatic (most recent private chat)</SelectItem>
                {chats.map((chat) => (
                  <SelectItem key={chat.chatId} value={chat.chatId}>
                    {chat.label}
                    {chat.chatType === "group" ? " — group" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Pinning a group chat sends notifications to everyone in it.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : account.notifyChat ? (
            <div className="liquid-glass-inner rounded-2xl border-0 px-4 py-3">
              <p className="text-sm font-medium">Currently: {account.notifyChat.label}</p>
              <p className="text-muted-foreground mt-0.5 text-xs break-all">
                {account.notifyChat.chatId} · {NOTIFY_SOURCE_LABELS[account.notifyChat.source]}
              </p>
            </div>
          ) : (
            <div className="text-muted-foreground py-6 text-center text-sm">
              No chat available yet — message your bot on Telegram and it will appear here.
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
