"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/shared/copy-button";
import { patchJson, postJson } from "@/lib/http";
import type { SsoProviderStatus } from "@/lib/auth/sso-config";

interface SsoProviderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the sheet edits this provider; otherwise it adds one. */
  provider: SsoProviderStatus | null;
  onSaved: (provider: SsoProviderStatus, created: boolean) => void;
}

interface Form {
  name: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowedDomains: string;
}

function formOf(provider: SsoProviderStatus | null): Form {
  return {
    name: provider?.name ?? "",
    enabled: provider?.enabled ?? true,
    issuer: provider?.issuer ?? "",
    clientId: provider?.clientId ?? "",
    clientSecret: "",
    scopes: (provider?.scopes ?? []).join(" "),
    allowedDomains: (provider?.allowedDomains ?? []).join(", "),
  };
}

function listOf(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * One identity provider's settings.
 *
 * The redirect URI is shown once the provider is stored, because the callback
 * carries the provider's own slug: adding one saves first, and the sheet then
 * stays open on the value to register at the provider.
 */
export function SsoProviderSheet({ open, onOpenChange, provider, onSaved }: SsoProviderSheetProps) {
  const isEdit = provider !== null;
  const [form, setForm] = useState(() => formOf(provider));
  const [key, setKey] = useState(provider?.id ?? "new");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Re-seed when a different provider is opened, and after the first save.
  const nextKey = provider?.id ?? "new";
  if (nextKey !== key) {
    setKey(nextKey);
    setForm(formOf(provider));
    setError("");
  }

  const update = (patch: Partial<Form>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || saving) return;

    const payload = {
      name: form.name.trim(),
      enabled: form.enabled,
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      scopes: listOf(form.scopes, /\s+/),
      allowedDomains: listOf(form.allowedDomains, /[\s,]+/),
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    };

    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        const data = await patchJson<{ provider: SsoProviderStatus }>(
          `/api/admin/sso/${provider.id}`,
          payload,
        );
        toast.success("Provider saved");
        onSaved(data.provider, false);
        onOpenChange(false);
      } else {
        const data = await postJson<{ provider: SsoProviderStatus }>("/api/admin/sso", payload);
        toast.success("Provider added. Register its redirect URI at the provider.");
        onSaved(data.provider, true);
      }
    } catch (err) {
      console.error("Failed to save the single sign-on provider:", err);
      setError(err instanceof Error && err.message ? err.message : "Could not save the provider");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full max-w-[440px] flex-col overflow-hidden p-0">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {isEdit ? "Edit provider" : "Add provider"}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs">
              {isEdit
                ? "Change how this provider signs people in."
                : "An OpenID Connect provider such as Entra ID, Okta or Google Workspace."}
            </SheetDescription>
          </SheetHeader>

          <form
            id="sso-provider-form"
            onSubmit={handleSubmit}
            className="flex-1 overflow-y-auto px-6 py-5"
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="sso-enabled" className="text-xs">
                    Offered on the login page
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Off keeps the credentials, and hides the button.
                  </p>
                </div>
                <Switch
                  id="sso-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-name" className="text-xs">
                  Name *
                </Label>
                <Input
                  id="sso-name"
                  value={form.name}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="Company SSO"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">What the sign-in button says.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-issuer" className="text-xs">
                  Issuer
                </Label>
                <Input
                  id="sso-issuer"
                  value={form.issuer}
                  onChange={(event) => update({ issuer: event.target.value })}
                  placeholder="https://login.example.com/tenant"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  The provider&apos;s issuer URL, such as https://login.example.com/tenant.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-client-id" className="text-xs">
                  Client ID
                </Label>
                <Input
                  id="sso-client-id"
                  value={form.clientId}
                  onChange={(event) => update({ clientId: event.target.value })}
                  placeholder="the application registered at the provider"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-client-secret" className="text-xs">
                  Client secret
                </Label>
                <Input
                  id="sso-client-secret"
                  type="password"
                  value={form.clientSecret}
                  onChange={(event) => update({ clientSecret: event.target.value })}
                  placeholder={provider?.hasClientSecret ? "unchanged" : ""}
                  autoComplete="new-password"
                />
                <p className="text-muted-foreground text-xs">
                  {provider?.hasClientSecret
                    ? "A secret is stored. Type a new one to replace it."
                    : "Paste the secret from the provider's application registration."}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-domains" className="text-xs">
                  Allowed domains
                </Label>
                <Input
                  id="sso-domains"
                  value={form.allowedDomains}
                  onChange={(event) => update({ allowedDomains: event.target.value })}
                  placeholder="example.com, example.org"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  Addresses at these domains get an account on first sign-in. Empty means only
                  accounts an admin made can sign in.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sso-scopes" className="text-xs">
                  Scopes
                </Label>
                <Input
                  id="sso-scopes"
                  value={form.scopes}
                  onChange={(event) => update({ scopes: event.target.value })}
                  placeholder="openid profile email"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">openid is always asked for.</p>
              </div>

              {provider ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Redirect URI</Label>
                  <div className="bg-muted border-border flex items-center gap-2 rounded-lg border px-3 py-2">
                    <span className="min-w-0 flex-1 font-mono text-xs break-all">
                      {provider.redirectUri}
                    </span>
                    <CopyButton
                      text={provider.redirectUri}
                      label="Copy the redirect URI"
                      className="text-muted-foreground hover:text-foreground shrink-0"
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Register this at the provider. Sign-in cannot come back without it.
                  </p>
                </div>
              ) : null}

              {error ? (
                <div className="text-destructive bg-destructive/10 rounded-xl px-4 py-2.5 text-sm">
                  {error}
                </div>
              ) : null}
            </div>
          </form>

          <div className="border-border/30 border-t px-6 py-4">
            <Button
              form="sso-provider-form"
              type="submit"
              disabled={saving || !form.name.trim()}
              className="h-9 w-full text-xs font-medium"
            >
              {saving ? "Saving…" : isEdit ? "Save provider" : "Add provider"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
