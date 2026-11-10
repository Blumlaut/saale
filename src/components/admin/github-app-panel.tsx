"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { deleteJson, fetchJson, patchJson, putJson } from "@/lib/http";

/** The app as the API serializes it: identity and state, never the secrets. */
interface GithubAppSummary {
  appId: string;
  clientId: string;
  slug: string;
  name: string;
  ownerLogin: string;
  permissions: Record<string, string> | null;
  enabled: boolean;
  updatedAt: string;
}

interface AppResponse {
  app: GithubAppSummary | null;
  /** The value the app's Homepage URL has to be. */
  publicUrl?: string;
  callbackUrl?: string;
  setupUrl?: string;
  /** How many accounts authorized the app. */
  connectedAccounts?: number;
  /** How many accounts it is installed on. */
  installations?: number;
  /** Which credential wins when an account also keeps its own GH_TOKEN. */
  tokenPrecedence?: "app" | "variable";
}

interface CredentialForm {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

const EMPTY_FORM: CredentialForm = { appId: "", clientId: "", clientSecret: "", privateKey: "" };

/** The wizard's three steps, in the order they have to happen. */
const STEPS = [
  { id: 1, label: "Register", description: "One GitHub App for this instance" },
  { id: 2, label: "Credentials", description: "The four values GitHub gives you" },
  { id: 3, label: "Connect", description: "Accounts sign in and install it" },
] as const;

/** The two identities GitHub commands can act as. */
const CREDENTIAL_OPTIONS = [
  {
    value: "app" as const,
    label: "This instance's GitHub App",
    detail: "Acts as the app, narrowed per chat to that chat's repository.",
  },
  {
    value: "variable" as const,
    label: "The account's own login",
    detail: "Acts as the account's own token. The app's token is not used.",
  },
];

/** Permissions the app needs, in the words GitHub's form uses. */
const REQUIRED_PERMISSIONS: { name: string; level: string; why: string }[] = [
  { name: "Contents", level: "Read & write", why: "clone, fetch and push" },
  { name: "Pull requests", level: "Read & write", why: "open and read pull requests" },
  { name: "Workflows", level: "Read & write", why: "push branches that touch a workflow file" },
  { name: "Checks", level: "Read", why: "the check badge on a branch" },
];

/**
 * The instance's GitHub App, set up one step at a time.
 *
 * A wizard rather than a page of instructions: each step is the only thing on
 * screen, the next one appears when the step before it is done, and a saved app
 * opens on its summary instead. The steps are the ones GitHub imposes — register
 * the app, hand Saale its credentials, then let accounts sign in and install it —
 * and every URL in step 1 is derived from this instance's public URL, because a
 * mistyped Setup URL leaves the connection card waiting forever.
 */
export function GithubAppPanel() {
  const [app, setApp] = useState<GithubAppSummary | null>(null);
  const [urls, setUrls] = useState<{
    publicUrl: string;
    callbackUrl: string;
    setupUrl: string;
  } | null>(null);
  const [progress, setProgress] = useState({ connectedAccounts: 0, installations: 0 });
  const [precedence, setPrecedence] = useState<"app" | "variable">("app");
  const [savingPrecedence, setSavingPrecedence] = useState(false);

  const [loading, setLoading] = useState(true);
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<AppResponse>("/api/admin/github/app");
      setApp(data.app);
      if (data.publicUrl && data.callbackUrl && data.setupUrl) {
        setUrls({
          publicUrl: data.publicUrl,
          callbackUrl: data.callbackUrl,
          setupUrl: data.setupUrl,
        });
      }
      setProgress({
        connectedAccounts: data.connectedAccounts ?? 0,
        installations: data.installations ?? 0,
      });
      if (data.tokenPrecedence) setPrecedence(data.tokenPrecedence);
      // Nothing saved yet: the only sensible place to be is the first step.
      if (!data.app) {
        setWizard(true);
        setStep(1);
      }
    } catch (err) {
      console.error("Failed to read the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to read the GitHub App");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const field = (key: keyof CredentialForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const formIsComplete =
    form.appId.trim().length > 0 &&
    form.clientId.trim().length > 0 &&
    form.clientSecret.trim().length > 0 &&
    form.privateKey.trim().length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await putJson<AppResponse>("/api/admin/github/app", form);
      setApp(data.app);
      setForm(EMPTY_FORM);
      toast.success("GitHub App saved");
      // The next step is the one that was waiting for these credentials.
      setStep(3);
    } catch (err) {
      console.error("Failed to save the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to save the GitHub App");
    } finally {
      setSaving(false);
    }
  };

  /**
   * One decision for the case where an account also keeps its own `GH_TOKEN`.
   *
   * Only one of the two is ever used; this says which.
   */
  const choosePrecedence = async (value: "app" | "variable") => {
    setSavingPrecedence(true);
    setError(null);
    try {
      const data = await patchJson<AppResponse>("/api/admin/github/app", {
        tokenPrecedence: value,
      });
      if (data.tokenPrecedence) setPrecedence(data.tokenPrecedence);
      toast.success(value === "app" ? "The GitHub App wins" : "The account's own token wins");
    } catch (err) {
      console.error("Failed to change the GitHub token precedence:", err);
      setError(err instanceof Error ? err.message : "Failed to change the token precedence");
    } finally {
      setSavingPrecedence(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const data = await patchJson<AppResponse>("/api/admin/github/app", { enabled });
      setApp(data.app);
    } catch (err) {
      console.error("Failed to switch the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to switch the GitHub App");
    } finally {
      setToggling(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setError(null);
    try {
      await deleteJson("/api/admin/github/app");
      setApp(null);
      setWizard(true);
      setStep(1);
      toast.success("GitHub App removed");
    } catch (err) {
      console.error("Failed to remove the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to remove the GitHub App");
    }
  };

  // Until the read answers, showing the wizard would look like "nothing is
  // configured" — which is the one thing this panel must not guess at.
  if (loading) {
    return (
      <GlassPanel>
        <GlassPanelContent className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-9 w-32" />
        </GlassPanelContent>
      </GlassPanel>
    );
  }

  const editing = wizard || !app;
  const currentStep = STEPS.find((entry) => entry.id === step) ?? STEPS[0];

  /**
   * What still has to happen before the wizard may move on.
   *
   * Step 1 has nothing Saale can check — the app is created in another browser
   * tab — so the admin confirms it there. Step 3 only exists once a credential
   * set was saved and verified, which is what `app` records.
   */
  const blockedBecause =
    step === 1 && !acknowledged
      ? "Confirm that the app is created to continue."
      : step === 2 && !app
        ? "Save and verify the credentials to continue."
        : null;

  /**
   * Where "Back" leads from the step it is on.
   *
   * With a saved app, step 1 (register it on GitHub) is behind the user: going
   * back from the credentials closes the wizard and shows the overview of the
   * app that is connected instead. In a fresh setup it walks the steps it came
   * through. Either way step 1 is only reachable while there is no app yet.
   */
  const goBack = () => {
    if (step === 3) return setStep(2);
    if (app) return setWizard(false);
    return setStep(1);
  };

  /** A step may be opened when it is still ahead of what was done. */
  const canOpenStep = (target: 1 | 2 | 3): boolean =>
    (target !== 1 || !app) && (target < 3 || Boolean(app));

  return (
    <div className="space-y-4">
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!editing && app ? (
        <GlassPanel>
          <GlassPanelHeader title="GitHub App">
            <div className="flex items-center gap-2">
              <Badge variant={app.enabled ? "secondary" : "outline"} className="rounded-full">
                {app.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch
                checked={app.enabled}
                disabled={toggling}
                onCheckedChange={(checked) => void toggle(checked)}
                aria-label="Enable the GitHub App"
              />
            </div>
          </GlassPanelHeader>
          <GlassPanelContent className="space-y-4">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground text-xs">App</dt>
                <dd className="font-medium">{app.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Owner</dt>
                <dd className="font-medium">{app.ownerLogin}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">App id</dt>
                <dd className="font-mono text-xs">{app.appId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Client id</dt>
                <dd className="font-mono text-xs break-all">{app.clientId}</dd>
              </div>
            </dl>

            {app.permissions && Object.keys(app.permissions).length > 0 && (
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Granted permissions</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(app.permissions)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, level]) => (
                      <Badge
                        key={name}
                        variant="outline"
                        className="rounded-full font-mono text-xs"
                      >
                        {name}: {level}
                      </Badge>
                    ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                {progress.connectedAccounts} account{progress.connectedAccounts === 1 ? "" : "s"}{" "}
                connected
              </span>
              <span className="text-muted-foreground">
                {progress.installations} installation{progress.installations === 1 ? "" : "s"}
              </span>
            </div>

            <div className="border-border/60 space-y-1.5 border-t pt-3">
              <p className="text-sm font-medium">Who acts on GitHub</p>
              <p className="text-muted-foreground text-xs">
                Every GitHub command in a workspace acts as exactly one identity. This decides which
                one, for the whole instance — so an account that also keeps its own token never ends
                up with both.
              </p>
              <RadioGroup
                aria-label="Which GitHub credential wins"
                value={precedence}
                disabled={savingPrecedence}
                onValueChange={(value) => {
                  if (value === "app" || value === "variable") void choosePrecedence(value);
                }}
                className="border-border/60 divide-border/60 divide-y overflow-hidden rounded-2xl border"
              >
                {CREDENTIAL_OPTIONS.map((option) => (
                  <Label
                    key={option.value}
                    className="hover:bg-muted/60 flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors"
                  >
                    <Radio value={option.value} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-sm">{option.label}</span>
                      <span className="text-muted-foreground block text-xs">{option.detail}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setWizard(true);
                  setStep(2);
                }}
              >
                Replace credentials
              </Button>
              {/*
                Only while nothing is connected yet: once an account has
                authorized the app, the setup is behind you and the wizard's
                first step (register the app on GitHub) has nothing left to say.
              */}
              {progress.connectedAccounts === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setWizard(true);
                    setStep(1);
                  }}
                >
                  Setup steps
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={`https://github.com/apps/${app.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on GitHub
                  <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </GlassPanelContent>
        </GlassPanel>
      ) : (
        <GlassPanel>
          <GlassPanelHeader title="Set up a GitHub App">
            {app && (
              <Button variant="ghost" size="sm" onClick={() => setWizard(false)}>
                Cancel
              </Button>
            )}
          </GlassPanelHeader>
          <GlassPanelContent className="space-y-4">
            <ol className="flex items-center justify-center gap-2 py-1" aria-label="Setup steps">
              {STEPS.map((entry, index) => {
                const active = entry.id === step;
                const done = entry.id < step || (entry.id === 2 && Boolean(app));
                return (
                  <li key={entry.id} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => setStep(entry.id)}
                      disabled={!canOpenStep(entry.id)}
                      aria-current={active ? "step" : undefined}
                      className="flex flex-col items-center gap-1.5 rounded-2xl px-1.5 py-1 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-full border font-mono text-xs transition-colors",
                          done
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : active
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border text-muted-foreground",
                        )}
                      >
                        {done ? <Check className="h-4 w-4" /> : entry.id}
                      </span>
                      <span
                        className={cn(
                          "text-[11px]",
                          active ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {entry.label}
                      </span>
                    </button>
                    {index < STEPS.length - 1 && (
                      <span
                        aria-hidden
                        className={cn(
                          "mx-1 mb-5 h-px w-6 sm:w-10",
                          done ? "bg-primary/40" : "bg-border",
                        )}
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            <div className="space-y-1 text-center">
              <h3 className="text-sm font-medium">
                {step}. {currentStep.label}
              </h3>
              <p className="text-muted-foreground text-sm">{currentStep.description}</p>
            </div>

            {step === 1 && (
              <div className="space-y-3">
                <p className="text-sm">
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    New GitHub App
                    <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
                  </a>{" "}
                  — this instance&apos;s own app, so every account authorizes Saale and not somebody
                  else&apos;s.
                </p>

                {urls && (
                  <div className="space-y-1.5">
                    <UrlRow label="Homepage URL" value={urls.publicUrl} />
                    <UrlRow label="Callback URL" value={urls.callbackUrl} />
                    <UrlRow label="Setup URL" value={urls.setupUrl} />
                  </div>
                )}

                <p className="text-muted-foreground text-xs">
                  “Where can this GitHub App be installed?” — choose{" "}
                  <span className="text-foreground">Any account</span> when more than one account of
                  this workspace should install the app. On “Only this account”, everybody else can
                  authorize it but never install it, so they see no repositories.
                </p>

                <div className="border-border/60 overflow-hidden rounded-2xl border">
                  <div className="border-border/60 flex items-baseline justify-between gap-2 border-b px-3 py-2">
                    <p className="text-xs font-medium">Repository permissions</p>
                    <p className="text-muted-foreground text-[11px]">everything else: no access</p>
                  </div>
                  <ul className="divide-border/60 divide-y">
                    {REQUIRED_PERMISSIONS.map((permission) => (
                      <li
                        key={permission.name}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-medium">{permission.name}</p>
                          <p className="text-muted-foreground text-[11px]">{permission.why}</p>
                        </div>
                        <Badge
                          variant="outline"
                          className="shrink-0 rounded-full font-mono text-[10px]"
                        >
                          {permission.level}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <p className="border-border/60 text-muted-foreground border-t px-3 py-2 text-[11px]">
                    Turn on <span className="text-foreground">Enable Device Flow</span> and{" "}
                    <span className="text-foreground">Redirect on update</span>; leave the webhook
                    off.
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I created the app on GitHub with these URLs and permissions
                    <span className="text-muted-foreground block text-xs">
                      Nothing can check that from here — it happens in the other tab.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  Saving verifies the credentials against GitHub before storing them — a wrong app
                  id or key is refused here, not in the first chat.
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="github-app-id">App id</Label>
                    <Input
                      id="github-app-id"
                      inputMode="numeric"
                      autoComplete="off"
                      value={form.appId}
                      onChange={(event) => field("appId")(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="github-client-id">Client id</Label>
                    <Input
                      id="github-client-id"
                      autoComplete="off"
                      value={form.clientId}
                      onChange={(event) => field("clientId")(event.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="github-client-secret">Client secret</Label>
                  <Input
                    id="github-client-secret"
                    type="password"
                    autoComplete="off"
                    value={form.clientSecret}
                    onChange={(event) => field("clientSecret")(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    Used to refresh a user&apos;s eight-hour token. Stored encrypted and never shown
                    again.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="github-private-key">Private key</Label>
                  <Textarea
                    id="github-private-key"
                    rows={6}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder="-----BEGIN RSA PRIVATE KEY-----"
                    value={form.privateKey}
                    onChange={(event) => field("privateKey")(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    The .pem file GitHub generated for the app. It signs the app token that mints
                    installation tokens.
                  </p>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                {app ? (
                  <p className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-emerald-500" />
                    {app.name} is configured
                    {app.enabled ? "" : " but switched off"}.
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Save the credentials in step 2 first; this step is where accounts connect.
                  </p>
                )}

                <div className="space-y-1 text-xs">
                  <p className="text-muted-foreground">
                    {progress.connectedAccounts} account
                    {progress.connectedAccounts === 1 ? "" : "s"} authorized ·{" "}
                    {progress.installations} installation
                    {progress.installations === 1 ? "" : "s"}
                  </p>
                  <p className="text-muted-foreground">
                    Each account continues on{" "}
                    <span className="text-foreground">Settings → Integrations → GitHub</span>:
                    device code, install, then pick repositories.
                  </p>
                </div>

                <Button variant="secondary" size="sm" asChild>
                  <a href="/dashboard/settings/integrations">
                    Open the Integrations card
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            )}

            {blockedBecause && <p className="text-muted-foreground text-xs">{blockedBecause}</p>}

            <div className="border-border/60 flex items-center justify-between gap-2 border-t pt-3">
              <Button variant="ghost" size="sm" onClick={goBack} disabled={step === 1}>
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                Back
              </Button>

              <div className="flex items-center gap-2">
                {step < 3 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStep((step + 1) as 2 | 3)}
                    disabled={Boolean(blockedBecause)}
                  >
                    Next
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                )}
                {step === 2 && (
                  <Button
                    size="sm"
                    onClick={() => void save()}
                    disabled={saving || !formIsComplete}
                  >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save and verify
                  </Button>
                )}
                {step === 3 && app && (
                  <Button size="sm" onClick={() => setWizard(false)}>
                    Done
                  </Button>
                )}
              </div>
            </div>
          </GlassPanelContent>
        </GlassPanel>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the GitHub App?</AlertDialogTitle>
            <AlertDialogDescription>
              Its installations and every token an account authorized with it are deleted. The
              authorization itself stays at GitHub — remove it there under “Authorized GitHub Apps”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One value an admin copies into GitHub's form. */
function UrlRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        toast.success(`${label} copied`);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error(`Failed to copy the GitHub App ${label}:`, err);
        toast.error("Could not copy the value");
      });
  };

  return (
    <div className="bg-muted flex items-center justify-between gap-2 rounded-2xl px-3 py-1.5">
      <div className="min-w-0">
        <p className="text-muted-foreground text-[11px]">{label}</p>
        <code className="block truncate font-mono text-xs">{value}</code>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={copy}
        aria-label={`Copy the ${label}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
