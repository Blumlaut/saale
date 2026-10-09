"use client";

import {
  GitFork,
  Trash2,
  MoreVertical,
  ExternalLink,
  Loader2,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { GitHubAccount } from "@/hooks/use-github-integration";
import { INTEGRATION_MAP } from "@/lib/integrations/registry";
import { IntegrationBox } from "./integration-box";

/**
 * The GitHub box on the Integrations tab: the connected account (with the
 * enable switch and remove behind the menu), or a button into the connect
 * dialog.
 *
 * Receives all data and actions as props from the parent to avoid
 * duplicate API calls.
 */
export function GitHubBox({
  account,
  onToggleEnabled,
  onDelete,
  onConnect,
  actionLoading,
}: {
  account: GitHubAccount | null;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  /** Opens the connect dialog. */
  onConnect: () => void;
  actionLoading: string | null;
}) {
  return (
    <IntegrationBox
      manifest={INTEGRATION_MAP.get("github")!}
      connected={!!account}
      badges={
        account ? (
          <>
            {account.username && (
              <Badge variant="secondary" className="rounded-full">
                {account.username}
              </Badge>
            )}
            {!account.enabled && (
              <Badge variant="outline" className="rounded-full">
                Disabled
              </Badge>
            )}
          </>
        ) : null
      }
    >
      {account ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground mt-0.5 text-xs">
              {account.enabled ? "Agents can act on this account" : "Switched off"}
            </p>
            <p className="text-muted-foreground text-xs">
              Added {new Date(account.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : (
        <Button size="sm" className="liquid-glass-accent rounded-full" onClick={onConnect}>
          <GitFork className="mr-2 h-4 w-4" />
          Connect GitHub
        </Button>
      )}
    </IntegrationBox>
  );
}

/**
 * The connect flow: paste a personal access token.
 *
 * The token never leaves this dialog — on close the form resets, so a half
 * typed token is not reused by accident.
 */
export function GitHubConnectDialog({
  open,
  onOpenChange,
  token,
  onTokenChange,
  error,
  success,
  saving,
  onSave,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onTokenChange: (value: string) => void;
  error: string | null;
  success: boolean;
  saving: boolean;
  onSave: () => void;
  /** Called when the dialog closes — resets the token form. */
  onClosed: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onClosed();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="h-5 w-5 text-gray-500" />
            Connect GitHub
          </DialogTitle>
          <DialogDescription>
            Connect a GitHub account so agents can manage repos, PRs, and issues with the gh CLI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-sm">Personal Access Token</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") onSave();
              }}
            />
            <p className="text-muted-foreground text-xs">
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
            </p>
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
              GitHub connected successfully!
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            className="liquid-glass-accent h-9 rounded-full text-xs font-medium"
            onClick={onSave}
            disabled={saving || !token.trim()}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
