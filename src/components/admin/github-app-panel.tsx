"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
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
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
}

interface CredentialForm {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

const EMPTY_FORM: CredentialForm = { appId: "", clientId: "", clientSecret: "", privateKey: "" };

/** Permissions the app needs, in the words GitHub's form uses. */
const REQUIRED_PERMISSIONS: { name: string; level: string; why: string }[] = [
  { name: "Contents", level: "Read & write", why: "clone, fetch and push" },
  { name: "Pull requests", level: "Read & write", why: "open and read pull requests" },
  { name: "Workflows", level: "Read & write", why: "push branches that touch a workflow file" },
  { name: "Checks", level: "Read", why: "the check badge on a branch" },
];

/**
 * The instance's GitHub App, as an admin configures it.
 *
 * One row, instance-wide: its private key decides what every workspace may do on
 * GitHub. The four fields are write-only — the API never echoes the secret or the
 * key — so replacing them means saving a complete set again.
 */
export function GithubAppPanel() {
  const [app, setApp] = useState<GithubAppSummary | null>(null);
  const [urls, setUrls] = useState<{
    publicUrl: string;
    callbackUrl: string;
    setupUrl: string;
  } | null>(null);
  const [progress, setProgress] = useState({ connectedAccounts: 0, installations: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [replacing, setReplacing] = useState(false);
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

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await putJson<AppResponse>("/api/admin/github/app", form);
      setApp(data.app);
      setForm(EMPTY_FORM);
      setReplacing(false);
      toast.success("GitHub App saved");
    } catch (err) {
      console.error("Failed to save the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to save the GitHub App");
    } finally {
      setSaving(false);
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
      setReplacing(false);
      toast.success("GitHub App removed");
    } catch (err) {
      console.error("Failed to remove the GitHub App:", err);
      setError(err instanceof Error ? err.message : "Failed to remove the GitHub App");
    }
  };

  const formIsComplete =
    form.appId.trim().length > 0 &&
    form.clientId.trim().length > 0 &&
    form.clientSecret.trim().length > 0 &&
    form.privateKey.trim().length > 0;

  // Until the read answers, showing the empty form would look like "nothing is
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

  return (
    <div className="space-y-4">
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <SetupProgress app={app} urls={urls} progress={progress} onSaved={Boolean(app)} />

      {app && !replacing && (
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

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
                Replace credentials
              </Button>
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
      )}

      {(!app || replacing) && (
        <GlassPanel>
          <GlassPanelHeader title={app ? "Replace the credentials" : "Add a GitHub App"}>
            {replacing && (
              <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            )}
          </GlassPanelHeader>
          <GlassPanelContent className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">1. Create the app on GitHub</h3>
              <p className="text-muted-foreground text-sm">
                <a
                  href="https://github.com/settings/apps/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  New GitHub App
                  <ExternalLink className="ml-0.5 inline-block h-3 w-3" />
                </a>{" "}
                — this instance&apos;s own app, so every account authorizes Saale and not some
                shared app.
              </p>
              {urls && (
                <div className="space-y-1.5">
                  <UrlRow label="Homepage URL" value={urls.publicUrl} />
                  <UrlRow label="Callback URL" value={urls.callbackUrl} />
                  <UrlRow label="Setup URL" value={urls.setupUrl} />
                  <p className="text-muted-foreground text-xs">
                    Turn on <span className="text-foreground">Enable Device Flow</span>, tick{" "}
                    <span className="text-foreground">Redirect on update</span>, and leave the
                    webhook off.
                  </p>
                </div>
              )}
              <ul className="text-muted-foreground space-y-1 text-xs">
                {REQUIRED_PERMISSIONS.map((permission) => (
                  <li key={permission.name}>
                    <span className="text-foreground">{permission.name}</span> — {permission.level}{" "}
                    ({permission.why})
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">2. Paste what GitHub gave you</h3>
              <p className="text-muted-foreground text-sm">
                Saving verifies the credentials against GitHub before storing them — a wrong app id
                or key is refused here, not in the first chat.
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

              <div className="flex justify-end">
                <Button onClick={() => void save()} disabled={saving || !formIsComplete}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save and verify
                </Button>
              </div>
            </section>

            <section className="space-y-1">
              <h3 className="text-sm font-medium">3. Connect an account</h3>
              <p className="text-muted-foreground text-sm">
                On <span className="text-foreground">Settings → Integrations → GitHub</span> each
                account signs in with a device code, installs the app where it may live, and picks
                the repositories. That is where the setup continues.
              </p>
            </section>
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

/**
 * Where the instance stands, in the three steps the setup has.
 *
 * This is the admin's overview rather than a form: it answers "is it done?" and
 * "why is nothing happening?" without reading three screens. Each line is a fact
 * Saale already knows — saved credentials, authorized accounts, installations —
 * not a checkbox somebody ticked.
 */
function SetupProgress({
  app,
  urls,
  progress,
  onSaved,
}: {
  app: GithubAppSummary | null;
  urls: { publicUrl: string; callbackUrl: string; setupUrl: string } | null;
  progress: { connectedAccounts: number; installations: number };
  onSaved: boolean;
}) {
  const steps = [
    {
      label: "App in Saale",
      done: onSaved,
      detail: onSaved ? (app?.name ?? "saved") : "credentials not saved yet",
    },
    {
      label: "Accounts connected",
      done: progress.connectedAccounts > 0,
      detail:
        progress.connectedAccounts > 0
          ? `${progress.connectedAccounts} authorized`
          : "nobody signed in yet",
    },
    {
      label: "Installed",
      done: progress.installations > 0,
      detail:
        progress.installations > 0
          ? `${progress.installations} installation${progress.installations === 1 ? "" : "s"}`
          : "nothing installed yet",
    },
  ];

  return (
    <div className="border-border/60 space-y-2 rounded-2xl border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {steps.map((step, index) => (
          <div key={step.label} className="flex items-center gap-1.5">
            <span
              className={[
                "flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
                step.done
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground",
              ].join(" ")}
            >
              {step.done ? <Check className="h-3 w-3" /> : index + 1}
            </span>
            <div className="leading-tight">
              <p className="text-xs">{step.label}</p>
              <p className="text-muted-foreground text-[11px]">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {urls && !onSaved && (
        <p className="text-muted-foreground text-xs">
          Paste these three values into the app on GitHub while you are there.
        </p>
      )}
    </div>
  );
}
