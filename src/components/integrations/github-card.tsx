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
import { Checkbox } from "@/components/ui/checkbox";
import { isVariableTokenSource, type GithubCredential } from "@/lib/integrations/github";
import { IntegrationBox, type IntegrationBoxInfo } from "./integration-box";
import { useGithub, type GithubAppSection, type GithubRepositoryChoices } from "@/hooks/use-github";
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
    saveRepositories,
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
                  {app.installations.length > 0 ? "Manage repositories" : "Install on GitHub"}
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setPicking(entry.installationId)}
                      >
                        {entry.repositorySelection === "selected" && entry.repositories
                          ? `${entry.repositories.length} repositories`
                          : "All repositories"}
                      </Button>
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
        <RepositoryDialog
          installationId={picking}
          onClose={() => setPicking(null)}
          load={loadRepositories}
          save={saveRepositories}
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
 * GitHub is the authority: the list comes from what this account may add (admin
 * access), and the change is applied through the installation itself — so the
 * limit holds for every token Saale mints later, not just for one command.
 */
function RepositoryDialog({
  installationId,
  onClose,
  load,
  save,
}: {
  installationId: string;
  onClose: () => void;
  load: (installationId: string) => Promise<GithubRepositoryChoices | null>;
  save: (
    installationId: string,
    repositoryIds: readonly string[],
  ) => Promise<GithubRepositoryChoices | null>;
}) {
  const [choices, setChoices] = useState<GithubRepositoryChoices | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load(installationId).then((data) => {
      if (cancelled || !data) return;
      setChoices(data);
      setSelected(new Set(data.installed.map((entry) => entry.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [installationId, load]);

  const toggle = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    const data = await save(installationId, [...selected]);
    setBusy(false);
    if (!data) {
      setError("The selection could not be saved.");
      return;
    }
    toast.success("Repositories updated");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Repositories
          </DialogTitle>
          <DialogDescription>
            {choices
              ? `Which repositories Saale may use on ${choices.accountLogin}.`
              : "Loading what this installation covers…"}
          </DialogDescription>
        </DialogHeader>

        {choices && !choices.canManage ? (
          <div className="space-y-2 py-2">
            <p className="text-sm">
              This installation covers all repositories, so it cannot be narrowed here.
            </p>
            <p className="text-muted-foreground text-xs">
              On GitHub, switch it to “Only select repositories”, then choose the set in Saale.
            </p>
            <Button variant="secondary" size="sm" asChild>
              <a href={installationSettingsUrl(choices)} target="_blank" rel="noopener noreferrer">
                Manage on GitHub
                <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        ) : choices ? (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {choices.candidates.length === 0 && (
              <p className="text-muted-foreground py-2 text-xs">
                No repository of this account is one you administer, so there is nothing to add.
              </p>
            )}
            {choices.candidates.map((entry) => (
              <label
                key={entry.id}
                className="hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5"
              >
                <Checkbox
                  checked={selected.has(entry.id)}
                  onCheckedChange={(checked) => toggle(entry.id, checked === true)}
                />
                <span className="truncate font-mono text-xs">{entry.fullName}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">Asking GitHub…</span>
          </div>
        )}

        {error && <p className="text-destructive text-xs">{error}</p>}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          {choices?.canManage && (
            <Button size="sm" onClick={() => void apply()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => onChooseRepositories(entry.installationId)}
                  >
                    {entry.repositorySelection === "selected" && entry.repositories
                      ? `${entry.repositories.length} repositories`
                      : "All repositories"}
                  </Button>
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
