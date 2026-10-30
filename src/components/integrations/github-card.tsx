"use client";

import { useCallback, useEffect, useState } from "react";
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
import { ROW_ACTION } from "@/lib/utils";

/** GitHub is a workspace sign-in rather than a registry integration, so it carries its own metadata. */
const GITHUB_BOX: IntegrationBoxInfo = {
  name: "GitHub",
  description: "Private repositories, pushes and pull requests from your workspace",
  icon: GitBranch,
  color: "text-foreground",
};

/** How often the dialog asks whether GitHub has been approved yet. */
const POLL_MS = 3000;

/**
 * The GitHub box on the Integrations tab.
 *
 * There is no app to register and no token to paste: the box starts
 * `gh auth login` in the workspace and shows the code GitHub wants typed,
 * which is the same flow the terminal would walk the user through. What is
 * already set up is asked of `gh` itself, so a login made in the terminal or a
 * `GH_TOKEN` the user keeps in their variables shows up here as connected.
 */
export function GithubCard() {
  const { status, loading, starting, disconnecting, error, load, start, disconnect } = useGithub();
  const [open, setOpen] = useState(false);

  const { credential, pending } = status;
  const message = error ?? status.error;

  // The workspace answers for itself: while a code is out, the browser may
  // approve it at any moment.
  useEffect(() => {
    if (!open || credential) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, credential, load]);

  // A login made in the workspace terminal shows up when the tab is looked at
  // again, without polling gh while nobody is watching.
  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const connect = () => {
    setOpen(true);
    void start();
  };

  const close = useCallback(
    (next: boolean) => {
      setOpen(next);
      // A code left polling would sign the user in after they closed the dialog.
      if (!next && !credential) void disconnect();
    },
    [credential, disconnect],
  );

  return (
    <>
      <IntegrationBox manifest={GITHUB_BOX} connected={!!credential}>
        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">Checking…</span>
          </div>
        ) : credential ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs break-all">Signed in as @{credential.login}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {sourceLine(credential.source)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Sign out of GitHub"
              disabled={disconnecting}
              onClick={() => void disconnect()}
              className={`${ROW_ACTION} h-8 w-8 shrink-0`}
            >
              {disconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Button size="sm" className="liquid-glass-accent rounded-full" onClick={connect}>
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
              Your workspace runs GitHub&apos;s own sign-in. Approve the code once and every chat,
              worktree and command uses it.
            </DialogDescription>
          </DialogHeader>

          <SignInBody
            credential={credential}
            code={pending?.code ?? null}
            url={pending?.url ?? null}
            starting={starting}
            error={message}
          />

          <DialogFooter>
            <Button
              variant="outline"
              className="h-9 rounded-full text-xs font-medium"
              onClick={() => close(false)}
            >
              {credential ? "Done" : "Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Where gh took the token from, in words: its own login, or a variable the user set. */
function sourceLine(source: string): string {
  return source.includes("/")
    ? "gh and git use this login"
    : `gh and git use ${source} from your environment variables`;
}

function SignInBody({
  credential,
  code,
  url,
  starting,
  error,
}: {
  credential: { login: string; source: string } | null;
  code: string | null;
  url: string | null;
  starting: boolean;
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (credential) {
    return (
      <div className="space-y-2 py-2">
        <p className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-emerald-500" />
          Signed in as @{credential.login}
        </p>
        <p className="text-muted-foreground text-xs">{sourceLine(credential.source)}</p>
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
      <div className="space-y-3 py-2">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {starting ? "Asking GitHub for a code…" : "Waiting for the code…"}
        </p>
        {error && (
          <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 py-2">
      <p className="text-muted-foreground text-sm">
        Type this code at <span className="text-foreground">github.com/login/device</span>. GitHub
        asks you to approve it once, and this window notices on its own.
      </p>

      <div className="liquid-glass-inner rounded-2xl border-0 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <code className="font-mono text-lg font-medium tracking-widest break-all">{code}</code>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={copyCode}
            aria-label="Copy code"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {url && (
        <Button asChild className="liquid-glass-accent h-9 w-full rounded-full text-xs font-medium">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            Open GitHub
          </a>
        </Button>
      )}

      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Waiting for approval…
      </p>

      {error && (
        <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
    </div>
  );
}
