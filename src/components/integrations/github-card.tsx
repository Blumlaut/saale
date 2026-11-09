"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Check, Copy, ExternalLink, GitBranch, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IntegrationBox, type IntegrationBoxInfo } from "./integration-box";
import { useGithub } from "@/hooks/use-github";

/** GitHub is a workspace sign-in rather than a registry integration, so it carries its own metadata. */
const GITHUB_BOX: IntegrationBoxInfo = {
  name: "GitHub",
  description: "Private repositories, pushes and pull requests from your workspace",
  icon: GitBranch,
  color: "text-foreground",
};

/** How many installations the box names before it settles for a count. */
const MAX_NAMED_INSTALLATIONS = 3;

/**
 * The GitHub box on the Integrations tab.
 *
 * An instance that has a GitHub App offers it here: one device code, and the app
 * acts with the account's own permissions on the repositories it was installed
 * on. Everything the workspace needs is derived from it, so nothing is stored in
 * the workspace for this sign-in.
 *
 * An instance without an app keeps the GitHub CLI's own login, which runs in the
 * workspace and is read from `gh` itself — including a login made in the
 * terminal or a `GH_TOKEN` kept in the sandbox variables.
 */
export function GithubCard() {
  const { app, cli, loading, starting, disconnecting, error, connect, cancel, disconnect } =
    useGithub();
  const [open, setOpen] = useState(false);

  const message = error ?? cli.error;
  const connected = Boolean(app.authorized) || Boolean(cli.credential);

  // Both flows report the same two facts under different names.
  const code = app.pending?.userCode ?? cli.pending?.code ?? null;
  const url = app.pending?.verificationUri ?? cli.pending?.url ?? null;

  const startSignIn = () => {
    setOpen(true);
    void connect();
  };

  const close = useCallback(
    (next: boolean) => {
      setOpen(next);
      // A code left polling would sign the user in after they closed the dialog.
      if (!next && (app.pending || cli.pending)) void cancel();
    },
    [app.pending, cli.pending, cancel],
  );

  if (loading) {
    return (
      <IntegrationBox manifest={GITHUB_BOX} connected={false}>
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-xs">Checking…</span>
        </div>
      </IntegrationBox>
    );
  }

  return (
    <>
      <IntegrationBox manifest={GITHUB_BOX} connected={connected}>
        {app.configured ? (
          app.authorized ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs break-all">Signed in as @{app.authorized.login}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {app.installations.length === 0
                      ? "Not installed on any account yet"
                      : `Installed on ${installationSummary(app.installations.map((entry) => entry.accountLogin))}`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={disconnecting}
                  onClick={() => void disconnect("app")}
                >
                  {disconnecting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LogOut className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Sign out
                </Button>
              </div>

              {app.authorized && app.installations.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {app.installations
                    .filter((entry) => !entry.suspended)
                    .map((entry) => (
                      <span
                        key={entry.installationId}
                        className="border-border/60 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                      >
                        {entry.accountLogin}
                      </span>
                    ))}
                </div>
              )}

              {cli.credential && (
                <p className="text-muted-foreground text-xs">
                  The GitHub CLI is also signed in as @{cli.credential.login}.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Button size="sm" onClick={startSignIn}>
                <GitBranch className="mr-2 h-4 w-4" />
                Connect GitHub
              </Button>
              {message && <p className="text-destructive text-xs break-words">{message}</p>}
            </div>
          )
        ) : cli.credential ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs break-all">Signed in as @{cli.credential.login}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {sourceLine(cli.credential.source)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              disabled={disconnecting}
              onClick={() => void disconnect("cli")}
            >
              {disconnecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="mr-1.5 h-3.5 w-3.5" />
              )}
              Sign out
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Button size="sm" onClick={startSignIn}>
              <GitBranch className="mr-2 h-4 w-4" />
              Connect GitHub
            </Button>
            {message && <p className="text-destructive text-xs break-words">{message}</p>}
          </div>
        )}
      </IntegrationBox>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              Connect GitHub
            </DialogTitle>
            <DialogDescription>
              {app.configured
                ? "Approve the code once and this account is connected to the instance's GitHub App."
                : "Your workspace runs GitHub's own sign-in. Approve the code once and every chat, worktree and command uses it."}
            </DialogDescription>
          </DialogHeader>

          <SignInBody
            connected={
              app.authorized
                ? `Signed in as @${app.authorized.login}`
                : cli.credential
                  ? `Signed in as @${cli.credential.login}`
                  : null
            }
            code={code}
            url={url}
            starting={starting || disconnecting}
            error={message}
          />

          <DialogFooter>
            <Button
              variant="outline"
              className="h-9 text-xs font-medium"
              onClick={() => close(false)}
            >
              {connected ? "Done" : "Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "acme and 2 more", so the box names where it is installed without a list. */
function installationSummary(accounts: readonly string[]): string {
  const named = accounts.slice(0, MAX_NAMED_INSTALLATIONS);
  const rest = accounts.length - named.length;
  if (rest <= 0) return named.join(", ");
  return `${named.join(", ")} and ${rest} more`;
}

/** Where gh took the token from, in words: its own login, or a variable the user set. */
function sourceLine(source: string): string {
  return source.includes("/")
    ? "gh and git use this login"
    : `gh and git use ${source} from your environment variables`;
}

function SignInBody({
  connected,
  code,
  url,
  starting,
  error,
}: {
  connected: string | null;
  code: string | null;
  url: string | null;
  starting: boolean;
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (connected) {
    return (
      <div className="space-y-2 py-2">
        <p className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-emerald-500" />
          {connected}
        </p>
      </div>
    );
  }

  const copyCode = () => {
    if (!code) return;
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        toast.success("Code copied");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy the GitHub sign-in code:", err);
        toast.error("Could not copy the code");
      });
  };

  if (!code) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">
          {starting ? "Starting the sign-in…" : "Waiting for GitHub…"}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-2">
      <p className="text-sm">
        Open{" "}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary inline-flex items-center gap-1 underline underline-offset-2"
          >
            GitHub&apos;s device page
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          "GitHub's device page"
        )}{" "}
        and enter:
      </p>

      <div className="bg-muted flex items-center justify-between gap-3 rounded-2xl px-3 py-2">
        <code className="font-mono text-base tracking-wider">{code}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={copyCode}
          aria-label="Copy the GitHub sign-in code"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>

      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Waiting for you to approve it…
      </p>

      {error && (
        <p className="text-destructive flex items-start gap-2 text-xs break-words">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
