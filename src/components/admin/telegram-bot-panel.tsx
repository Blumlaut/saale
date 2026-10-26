"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageSection } from "@/components/layout/page";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import { AlertCircle, Check, Copy, ExternalLink, Loader2, MessageCircle } from "lucide-react";
import type { TelegramLoginStatus } from "@/lib/telegram/oidc";

interface AdminTelegramBot {
  configured: boolean;
  enabled?: boolean;
  botId?: string | null;
  botUsername?: string | null;
  /** How many users have linked an account to it. */
  linkCount?: number;
  updatedAt?: string;
}

interface SaveResponse {
  bot: AdminTelegramBot;
  login: TelegramLoginStatus;
  webhookRegistered: boolean;
}

/**
 * Whether users can sign in with Telegram, and what is left to configure.
 *
 * The credentials live in the environment, so this is a read-only report: it
 * exists because a half-done setup shows up nowhere else. the login page just
 * leaves the button out.
 */
function TelegramLoginBlock({ login }: { login: TelegramLoginStatus }) {
  const [copied, setCopied] = useState(false);

  const copyRedirectUri = () => {
    navigator.clipboard
      .writeText(login.redirectUri)
      .then(() => {
        setCopied(true);
        toast.success("Redirect URL copied");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy the Telegram redirect URL:", err);
        toast.error("Could not copy the URL");
      });
  };

  return (
    <div className="border-border/60 space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-sm font-medium">Sign in with Telegram</Label>
        <Badge variant={login.enabled ? "secondary" : "outline"} className="rounded-full">
          {login.enabled ? "Available" : login.configured ? "Misconfigured" : "Not set up"}
        </Badge>
      </div>

      {login.configured && !login.enabled && (
        <p className="text-destructive text-xs">
          {login.botId
            ? `TELEGRAM_OIDC_CLIENT_ID is ${login.clientId}, but this bot's id is ${login.botId}. sign-in is off until they match.`
            : "Sign-in is off until this bot is switched on, since a login has nothing to link an account to otherwise."}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        In{" "}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          @BotFather
          <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
        </a>{" "}
        open the bot, then <span className="text-foreground">Login Widget</span> and add the
        site&apos;s origin plus the redirect URL below. Copy the Client ID and Client Secret it
        shows into <code className="font-mono">TELEGRAM_OIDC_CLIENT_ID</code> and{" "}
        <code className="font-mono">TELEGRAM_OIDC_CLIENT_SECRET</code>, then restart. Telegram only
        sends an authorization code to a registered URL. an unregistered one comes back in the URL
        fragment, where the app never sees it.
      </p>

      <div className="liquid-glass-inner flex items-center justify-between gap-3 rounded-2xl border-0 px-3 py-1.5">
        <code className="font-mono text-xs break-all">{login.redirectUri}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={copyRedirectUri}
          aria-label="Copy the Telegram redirect URL"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Admin configuration for the instance's shared Telegram bot.
 *
 * Users no longer bring their own bot. they link their Telegram account to
 * this one. so the token lives here, behind the admin API, and is never sent
 * back to the browser.
 */
export function TelegramBotPanel({ flat }: { flat?: boolean } = {}) {
  const [bot, setBot] = useState<AdminTelegramBot | null>(null);
  const [login, setLogin] = useState<TelegramLoginStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ bot: AdminTelegramBot; login: TelegramLoginStatus }>(
        "/api/admin/telegram",
      );
      setBot(data.bot);
      setLogin(data.login);
    } catch (err) {
      console.error("Failed to load the Telegram bot configuration:", err);
      setBot({ configured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveToken = useCallback(async () => {
    if (!token.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const data = await postJson<SaveResponse>("/api/admin/telegram", { token: token.trim() });
      setBot(data.bot);
      setLogin(data.login);
      setToken("");
      if (data.webhookRegistered) {
        toast.success("Telegram bot saved");
      } else {
        // The token is valid (getMe passed) but Telegram would not accept the
        // webhook. almost always an unreachable app URL. Say so instead of
        // reporting a success the user will discover is not one.
        toast.warning("Bot saved, but Telegram rejected the webhook. check the app URL");
      }
    } catch (err) {
      console.error("Failed to save the Telegram bot token:", err);
      setError((err as Error).message || "Failed to save the bot token");
    } finally {
      setSaving(false);
    }
  }, [token]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    setToggling(true);
    try {
      const data = await patchJson<{ bot: AdminTelegramBot; login: TelegramLoginStatus }>(
        "/api/admin/telegram",
        { enabled },
      );
      setBot(data.bot);
      setLogin(data.login);
    } catch (err) {
      console.error("Failed to toggle the Telegram bot:", err);
      toast.error("Failed to change the bot's state");
    } finally {
      setToggling(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setRemoving(true);
    try {
      await deleteJson("/api/admin/telegram");
      setBot({ configured: false });
      toast.success("Telegram bot removed");
    } catch (err) {
      console.error("Failed to remove the Telegram bot:", err);
      toast.error("Failed to remove the bot");
    } finally {
      setRemoving(false);
      setRemoveOpen(false);
    }
  }, []);

  const content = (
    <GlassPanelContent className="p-0">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : bot?.configured ? (
        <div className="space-y-4 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-sm font-medium">Shared bot</Label>
                {bot.botUsername && (
                  <Badge variant="secondary" className="rounded-full">
                    @{bot.botUsername}
                  </Badge>
                )}
                {!bot.enabled && (
                  <Badge variant="outline" className="rounded-full">
                    Disabled
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs break-all">
                {bot.linkCount ?? 0} linked account{bot.linkCount === 1 ? "" : "s"}
                {bot.updatedAt ? ` · saved ${new Date(bot.updatedAt).toLocaleDateString()}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Enabled</span>
              <Switch
                checked={bot.enabled ?? false}
                onCheckedChange={toggleEnabled}
                disabled={toggling}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Replace bot token</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="123456:aBcDeF_gHiJkLmNoP-q"
                className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveToken();
                }}
              />
              <Button
                size="sm"
                className="h-9 shrink-0 rounded-full"
                onClick={saveToken}
                disabled={saving || !token.trim()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Users are told which bot to message, so changing it means everyone must link again.
            </p>
          </div>

          <Button
            variant="destructive"
            size="sm"
            className="h-8 rounded-full text-xs"
            onClick={() => setRemoveOpen(true)}
          >
            Remove bot
          </Button>

          {login && <TelegramLoginBlock login={login} />}
        </div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <div>
            <Label className="text-sm font-medium">Bot token</Label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Create a bot with{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                @BotFather
                <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
              </a>{" "}
              and paste its token here. Every user links their own Telegram account to this bot.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456:aBcDeF_gHiJkLmNoP-q"
              className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveToken();
              }}
            />
            <Button
              size="sm"
              className="h-9 shrink-0 rounded-full"
              onClick={saveToken}
              disabled={saving || !token.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <MessageCircle className="mr-2 h-3.5 w-3.5" />
                  Save bot
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-destructive bg-destructive/10 mx-4 mb-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
    </GlassPanelContent>
  );

  return (
    <>
      {flat ? (
        <PageSection title="Telegram">{content}</PageSection>
      ) : (
        <GlassPanel>
          <GlassPanelHeader title="Telegram" />
          {content}
        </GlassPanel>
      )}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Telegram bot</AlertDialogTitle>
            <AlertDialogDescription>
              The bot is removed and every linked account is unlinked. Users will have to link again
              if a new bot is configured later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} variant="destructive" disabled={removing}>
              {removing ? (
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
