"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  MessageCircle,
  Trash2,
  MoreVertical,
  Loader2,
  ExternalLink,
  Link2,
  Copy,
  AlertCircle,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type {
  TelegramBotStatus,
  TelegramLink,
  TelegramLinkCode,
} from "@/hooks/use-telegram-integration";
import { INTEGRATION_MAP } from "@/lib/integrations/registry";
import { IntegrationBox } from "./integration-box";

/**
 * The Telegram box on the Integrations tab.
 *
 * There is no bot token, no whitelist and no notification-chat picker — a
 * link is one user and one private chat. So the box shows either the linked
 * account (with relink/unlink behind the menu) or a button into the link
 * dialog.
 */
export function TelegramBox({
  link,
  bot,
  unlinking,
  onUnlink,
  onLink,
}: {
  link: TelegramLink | null;
  bot: TelegramBotStatus;
  unlinking: boolean;
  onUnlink: () => void;
  /** Opens the link dialog — first link or relink, the panel adapts. */
  onLink: () => void;
}) {
  return (
    <IntegrationBox
      manifest={INTEGRATION_MAP.get("telegram")!}
      connected={!!link}
      badges={
        bot.username ? (
          <Badge variant="secondary" className="rounded-full">
            @{bot.username}
          </Badge>
        ) : null
      }
    >
      {link ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs break-all">
              {link.displayName ? `${link.displayName} · ` : ""}ID {link.telegramUserId}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Linked {new Date(link.linkedAt).toLocaleDateString()}
              {bot.loginEnabled ? " · you can sign in with Telegram too" : ""}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={unlinking}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onLink}>
                <Link2 className="mr-2 h-4 w-4" />
                Link a different account
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onUnlink}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Unlink
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <Button size="sm" className="liquid-glass-accent rounded-full" onClick={onLink}>
          <Link2 className="mr-2 h-4 w-4" />
          Link Telegram
        </Button>
      )}
    </IntegrationBox>
  );
}

/** An explanatory line where the panel cannot offer a code. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="liquid-glass-inner text-muted-foreground rounded-2xl border-0 px-4 py-3 text-sm">
      {children}
    </div>
  );
}

/**
 * The linking flow: mint a one-time code, redeem it in Telegram.
 *
 * Rendered inside {@link TelegramLinkDialog}, which serves both the first
 * link (from the box's button) and relinking (from the box's menu).
 */
export function TelegramLinkPanel({
  bot,
  linkCode,
  linking,
  linkError,
  linked,
  onCreateCode,
}: {
  bot: TelegramBotStatus;
  linkCode: TelegramLinkCode | null;
  linking: boolean;
  linkError: string | null;
  /** Whether this user already has a link (changes the wording only). */
  linked: boolean;
  onCreateCode: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!bot.configured) {
    return (
      <Notice>
        No Telegram bot is set up on this instance yet. An admin can add one in{" "}
        <span className="text-foreground">Admin → Settings</span>.
      </Notice>
    );
  }

  if (!bot.enabled) {
    return (
      <Notice>
        The Telegram bot is switched off. An admin can enable it in{" "}
        <span className="text-foreground">Admin → Settings</span>.
      </Notice>
    );
  }

  const copyCode = () => {
    if (!linkCode) return;
    navigator.clipboard
      .writeText(linkCode.code)
      .then(() => {
        setCopied(true);
        toast.success("Link code copied");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy the Telegram link code:", err);
        toast.error("Could not copy the code");
      });
  };

  return (
    <div className="space-y-4 py-2">
      {linkError && (
        <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{linkError}</span>
        </div>
      )}

      {!linkCode ? (
        <>
          <p className="text-muted-foreground text-sm">
            {linked
              ? "Get a link code to connect a different Telegram account. It replaces the one currently linked."
              : `Saale talks to you through a shared Telegram bot${bot.username ? ` (@${bot.username})` : ""}. Get a link code and send it to the bot, and your Telegram account is connected.${bot.loginEnabled ? " That link is also how Telegram signs you in." : ""}`}
          </p>
          <Button
            className="liquid-glass-accent h-9 rounded-full text-xs font-medium"
            onClick={onCreateCode}
            disabled={linking}
          >
            {linking ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Link2 className="mr-2 h-3.5 w-3.5" />
                Get link code
              </>
            )}
          </Button>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Open Telegram and send the code below to{" "}
            <span className="text-foreground font-medium">
              {bot.username ? `@${bot.username}` : "the bot"}
            </span>
            . Just the code is enough — Telegram sends <code className="font-mono">/start</code> on
            its own when you open the chat. Tapping the button below does it for you.
          </p>

          <Button
            asChild
            className="liquid-glass-accent h-9 w-full rounded-full text-xs font-medium"
          >
            <a href={linkCode.deepLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              Open Telegram
            </a>
          </Button>

          <div className="liquid-glass-inner rounded-2xl border-0 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <code className="font-mono text-sm break-all">{linkCode.code}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={copyCode}
                aria-label="Copy link code"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            The code works once and expires at{" "}
            {new Date(linkCode.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
        </>
      )}
    </div>
  );
}

/** {@link TelegramLinkPanel} in a dialog, for relinking from the card. */
export function TelegramLinkDialog({
  open,
  onOpenChange,
  bot,
  linkCode,
  linking,
  linkError,
  linked,
  onCreateCode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: TelegramBotStatus;
  linkCode: TelegramLinkCode | null;
  linking: boolean;
  linkError: string | null;
  linked: boolean;
  onCreateCode: () => void;
  /** Called on close — the integration is re-fetched so a redeemed code shows up. */
  onDone: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onDone();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Link Telegram
          </DialogTitle>
          <DialogDescription>
            Link your Telegram account to this Saale account, so the bot knows whose agent to talk
            to.
          </DialogDescription>
        </DialogHeader>

        <TelegramLinkPanel
          bot={bot}
          linkCode={linkCode}
          linking={linking}
          linkError={linkError}
          linked={linked}
          onCreateCode={onCreateCode}
        />

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
