"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  LogOut,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  isVariableTokenSource,
  missingGithubAppPermissions,
  type GithubCredential,
} from "@/lib/integrations/github";
import { IntegrationBox, type IntegrationBoxInfo } from "./integration-box";
import {
  useGithub,
  type GithubAppSection,
  type GithubInstallationRepositories,
  type GithubRepositoriesAnswer,
} from "@/hooks/use-github";
import {
  installationSettingsUrl,
  manageInstallationsUrl,
  type InstallationLinkSource,
} from "@/lib/integrations/github-links";

/** Where GitHub hosts the install page for one app. */
/**
 * GitHub keeps the repository choice of an installation under the account's
 * settings; `/apps/<slug>/installations/` does not exist.
 */
function installationsUrl(slug: string, installations: readonly InstallationLinkSource[]): string {
  return manageInstallationsUrl(slug, installations);
}

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
  const {
    app,
    cli,
    loading,
    starting,
    disconnecting,
    error,
    connect,
    cancel,
    disconnect,
    loadRepositories,
  } = useGithub();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);

  const message = error ?? cli.error;
  const connected = Boolean(app.authorized) || Boolean(cli.credential);
  // `cli.credential` is what a command would use, which is not the same as a
  // login the workspace made: while the app is the source Saale's own `gh` shim
  // hands it our token, and an account's `GH_TOKEN` variable wins too. gh
  // reports both as a token from the environment, and only its own config is a
  // login worth naming beside the app's.
  const storedCliLogin =
    cli.credential && !isVariableTokenSource(cli.credential.source) ? cli.credential : null;

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
        {app.authorized ? (
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

            {app.slug && (
              <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" asChild>
                <a
                  href={installationsUrl(app.slug, app.installations)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Install / manage on GitHub
                  <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </Button>
            )}

            {app.authorized && app.installations.length > 0 && (
              <div className="space-y-1">
                {app.installations
                  .filter((entry) => !entry.suspended)
                  .map((entry) => (
                    <div
                      key={entry.installationId}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="font-mono text-[11px]">{entry.accountLogin}</span>
                      <RepositoriesButton
                        installation={entry}
                        onClick={() => setPicking(entry.installationId)}
                      />
                    </div>
                  ))}
              </div>
            )}

            {storedCliLogin && (
              <p className="text-muted-foreground text-xs">
                The GitHub CLI is also signed in as @{storedCliLogin.login}.
              </p>
            )}
          </div>
        ) : cli.credential ? (
          <CliLogin
            credential={cli.credential}
            appConfigured={app.configured}
            disconnecting={disconnecting}
            message={message}
            onDisconnect={() => void disconnect("cli")}
            onAuthorizeApp={startSignIn}
          />
        ) : (
          <ConnectGithub message={message} onClick={startSignIn} />
        )}
      </IntegrationBox>

      {picking && (
        <RepositoriesDialog
          installationId={picking}
          onClose={() => setPicking(null)}
          load={loadRepositories}
        />
      )}

      <GithubSetupDialog
        open={open}
        onClose={close}
        app={app}
        cli={cli}
        code={code}
        url={url}
        busy={starting || disconnecting}
        error={message}
        onStartSignIn={startSignIn}
        onInstall={() => {
          if (!app.slug) return;
          window.open(
            installationsUrl(app.slug, app.installations),
            "_blank",
            "noopener,noreferrer",
          );
        }}
        onChooseRepositories={(installationId) => setPicking(installationId)}
      />
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

/**
 * The per-installation control that opens Saale's repository picker.
 *
 * The count alone reads as a status line, so it carries an action icon: what it
 * shows is the set Saale last read from GitHub, and the click is what changes
 * it. GitHub's own page stays the other button, a few lines up.
 */
function RepositoriesButton({
  installation,
  onClick,
}: {
  installation: {
    accountLogin: string;
    repositorySelection: string;
    repositories: string[] | null;
  };
  onClick: () => void;
}) {
  const label =
    installation.repositorySelection === "selected" && installation.repositories
      ? `${installation.repositories.length} repositories`
      : "All repositories";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 px-2 text-[11px]"
      onClick={onClick}
      aria-label={`Repositories for ${installation.accountLogin}: ${label}`}
    >
      <SlidersHorizontal className="mr-1 h-3 w-3" />
      {label}
    </Button>
  );
}

/** The card's one action when nothing is connected, and whatever went wrong. */
function ConnectGithub({ message, onClick }: { message: string | null; onClick: () => void }) {
  return (
    <div className="space-y-2">
      <Button size="sm" onClick={onClick}>
        <GitBranch className="mr-2 h-4 w-4" />
        Connect GitHub
      </Button>
      {message && <p className="text-destructive text-xs break-words">{message}</p>}
    </div>
  );
}

/**
 * A login the workspace made itself, in the GitHub CLI's own config.
 *
 * An instance with an app still lands here whenever the account has not
 * authorized it — the login is what a command uses, so the box says who is
 * signed in instead of offering a connect button over a working credential.
 * Authorizing the app stays one click away, because the app is the source Saale
 * can refresh and narrow.
 */
function CliLogin({
  credential,
  appConfigured,
  disconnecting,
  message,
  onDisconnect,
  onAuthorizeApp,
}: {
  credential: GithubCredential;
  appConfigured: boolean;
  disconnecting: boolean;
  message: string | null;
  onDisconnect: () => void;
  onAuthorizeApp: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs break-all">Signed in as @{credential.login}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{sourceLine(credential.source)}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={disconnecting}
          onClick={onDisconnect}
        >
          {disconnecting ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
          )}
          Sign out
        </Button>
      </div>

      {appConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            The GitHub App is not authorized for your account yet.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onAuthorizeApp}
          >
            Authorize the app
          </Button>
        </div>
      )}

      {message && <p className="text-destructive text-xs break-words">{message}</p>}
    </div>
  );
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
  onRetry,
}: {
  connected: string | null;
  code: string | null;
  url: string | null;
  starting: boolean;
  error: string | null;
  /** Start a new sign-in when nothing is in flight. */
  onRetry: () => void;
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
    // No code and no approval means nothing is in flight: the code expired, or
    // the request never came back. A spinner here would claim to be waiting for
    // GitHub while nobody is, and leave closing the only way out.
    if (!starting) {
      return (
        <div className="space-y-2 py-2">
          <p className="text-muted-foreground text-sm">No sign-in is in flight.</p>
          <Button size="sm" onClick={onRetry}>
            <GitBranch className="mr-2 h-4 w-4" />
            Start the sign-in
          </Button>
          {error && (
            <p className="text-destructive flex items-start gap-2 text-xs break-words">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">Starting the sign-in…</span>
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

/**
 * Which repositories one installation covers.
 *
 * Read-only, and deliberately so: GitHub's two installation calls refuse a
 * repository the installation does not already cover, and a personal
 * installation cannot be extended over the API at all. So the card shows the set
 * — the same ceiling GitHub enforces for every token Saale mints — and points at
 * the page where it is changed.
 */
function RepositoriesDialog({
  installationId,
  onClose,
  load,
}: {
  installationId: string;
  onClose: () => void;
  load: (installationId: string) => Promise<GithubRepositoriesAnswer>;
}) {
  const [repositories, setRepositories] = useState<GithubInstallationRepositories | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load(installationId).then((answer) => {
      if (cancelled) return;
      setRepositories(answer.repositories);
      setError(answer.error);
    });
    return () => {
      cancelled = true;
    };
  }, [installationId, load]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Repositories
          </DialogTitle>
          <DialogDescription>
            {repositories
              ? `The repositories Saale may use on ${repositories.accountLogin}.`
              : "Loading what this installation covers…"}
          </DialogDescription>
        </DialogHeader>

        {repositories ? (
          <div className="space-y-2">
            {repositories.selection !== "selected" && (
              <p className="text-muted-foreground text-xs">
                This installation covers every repository of the account, so the list is what the
                app may reach today.
              </p>
            )}
            {repositories.installed.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No repository is installed yet, so the app can reach nothing.
              </p>
            ) : (
              <ul className="max-h-80 divide-y overflow-y-auto rounded-2xl border">
                {repositories.installed.map((entry) => (
                  <li key={entry.id} className="truncate px-3 py-1.5 font-mono text-xs">
                    {entry.fullName}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">Asking GitHub…</span>
          </div>
        )}

        {error && <p className="text-destructive text-xs">{error}</p>}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          {repositories && (
            <Button variant="secondary" size="sm" asChild>
              <a
                href={installationSettingsUrl(repositories)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Choose repositories on GitHub
                <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── The guided setup ───────────────────────────────────────────────────────

/** The steps an app connection goes through, in the order GitHub allows them. */
const SETUP_STEPS = ["Sign in", "Install", "Repositories"] as const;

/**
 * Which step the account is on, read from what GitHub already knows.
 *
 * Derived rather than stored: the dialog advances by itself the moment the poll
 * sees the authorization or the installation, which is what makes a sign-in that
 * finishes in another tab feel like the wizard moved on.
 */
function setupStep(app: GithubAppSection): 1 | 2 | 3 {
  if (!app.authorized) return 1;
  return app.installations.some((entry) => !entry.suspended) ? 3 : 2;
}

/** One number in the stepper: done, current, or still to come. */
function StepDot({ index, current }: { index: 1 | 2 | 3; current: 1 | 2 | 3 }) {
  const done = index < current;
  const active = index === current;
  return (
    <span
      className={[
        "flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
        done
          ? "border-primary/40 bg-primary/10 text-primary"
          : active
            ? "border-primary text-primary"
            : "border-border/60 text-muted-foreground",
      ].join(" ")}
      aria-current={active ? "step" : undefined}
    >
      {done ? <Check className="h-3 w-3" /> : index}
    </span>
  );
}

/**
 * The setup assistant for this instance's GitHub App.
 *
 * Three steps, in the only order GitHub permits: prove the account (device
 * code), install the app where it may live, then choose the repositories it may
 * reach. The dialog follows the account rather than a "next" button — a sign-in
 * approved in a browser tab, or an installation made on GitHub's page, moves the
 * assistant on as soon as the status poll reports it.
 */
function GithubSetupDialog({
  open,
  onClose,
  app,
  cli,
  code,
  url,
  busy,
  error,
  onStartSignIn,
  onInstall,
  onChooseRepositories,
}: {
  open: boolean;
  onClose: (next: boolean) => void;
  app: GithubAppSection;
  cli: { credential: { login: string } | null };
  code: string | null;
  url: string | null;
  busy: boolean;
  error: string | null;
  onStartSignIn: () => void;
  onInstall: () => void;
  onChooseRepositories: (installationId: string) => void;
}) {
  const step = setupStep(app);
  const installations = app.installations.filter((entry) => !entry.suspended);
  // What the app holds is GitHub's answer, not Saale's wish: the step says what
  // is missing rather than assuming the admin ticked every box.
  const missingPermissions = missingGithubAppPermissions(app.permissions);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            {app.configured ? `Set up ${app.name ?? "GitHub"}` : "Connect GitHub"}
          </DialogTitle>
          <DialogDescription>
            {app.configured
              ? "Three steps. Saale only ever reaches the repositories you install the app on."
              : "Your workspace runs GitHub's own sign-in. Approve the code once and every chat, worktree and command uses it."}
          </DialogDescription>
        </DialogHeader>

        {app.configured && (
          <div className="flex items-center gap-2" aria-label="Setup steps">
            {SETUP_STEPS.map((label, index) => {
              const number = (index + 1) as 1 | 2 | 3;
              return (
                <div key={label} className="flex min-w-0 items-center gap-1.5">
                  <StepDot index={number} current={step} />
                  <span
                    className={[
                      "truncate text-[11px]",
                      number === step ? "text-foreground" : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {label}
                  </span>
                  {number < SETUP_STEPS.length && <span className="text-border px-0.5">·</span>}
                </div>
              );
            })}
          </div>
        )}

        {!app.configured ? (
          <SignInBody
            connected={cli.credential ? `Signed in as @${cli.credential.login}` : null}
            code={code}
            url={url}
            starting={busy}
            error={error}
            onRetry={onStartSignIn}
          />
        ) : step === 1 ? (
          <div className="space-y-3">
            <SignInBody
              // Only the app's own authorization ends this step. A login in the
              // workspace's gh is a different credential, and counting it here
              // hid the device code: the dialog said "signed in" while step 1
              // could never finish, and step 2's install button never appeared.
              connected={app.authorized ? `Signed in as @${app.authorized.login}` : null}
              code={code}
              url={url}
              starting={busy}
              error={error}
              onRetry={onStartSignIn}
            />
            {app.permissions && (
              <div className="border-border/60 space-y-2 rounded-2xl border px-3 py-2">
                <p className="text-xs font-medium">
                  {app.name ?? "The app"} may, on installed repositories:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(app.permissions)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, level]) => (
                      <span
                        key={name}
                        className="border-border/60 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                      >
                        {name}: {level}
                      </span>
                    ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  Private repositories it is not installed on stay invisible, and no other account
                  can use your installation.
                </p>
                {missingPermissions.length > 0 && (
                  <div className="space-y-1 border-t border-dashed pt-2">
                    <p className="text-destructive flex items-start gap-1.5 text-xs">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {missingPermissions.length === 1
                        ? "One permission Saale works with is missing."
                        : `${missingPermissions.length} permissions Saale works with are missing.`}
                    </p>
                    <ul className="text-muted-foreground space-y-0.5 text-xs">
                      {missingPermissions.map((entry) => (
                        <li key={entry.name}>
                          <span className="font-mono text-[11px]">
                            {entry.name}: {entry.level}
                          </span>{" "}
                          — {entry.why}
                        </li>
                      ))}
                    </ul>
                    <p className="text-muted-foreground text-xs">
                      Add it under the app&apos;s permissions on GitHub; every installation then
                      approves it once.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : step === 2 ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-emerald-500" />
              Signed in as @{app.authorized?.login}
            </p>
            <p className="text-sm">
              Install {app.name ?? "the app"} on the account or organization whose repositories
              Saale may use.
            </p>
            <p className="text-muted-foreground text-xs">
              GitHub asks which repositories there — pick “Only select repositories” if you want to
              change the set here afterwards. This dialog moves on by itself when you come back.
            </p>
            {error && (
              <p className="text-destructive flex items-start gap-2 text-xs break-words">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-emerald-500" />
              Connected as @{app.authorized?.login}
            </p>
            <div className="space-y-1">
              {installations.map((entry) => (
                <div key={entry.installationId} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{entry.accountLogin}</span>
                  <RepositoriesButton
                    installation={entry}
                    onClick={() => onChooseRepositories(entry.installationId)}
                  />
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Each chat is then confined to its own project&apos;s repository.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onClose(false)}>
            {step === 3 || (!app.configured && cli.credential) ? "Done" : "Close"}
          </Button>
          {app.configured && step === 2 && (
            <Button size="sm" onClick={onInstall}>
              Install on GitHub
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
