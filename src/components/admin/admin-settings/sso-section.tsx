"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { PageSection } from "@/components/layout/page";
import { CopyButton } from "@/components/shared/copy-button";
import { SSO_DEFAULT_NAME, type SsoStatus } from "@/lib/auth/sso-config";
import { AdminSettingsFrame } from "./settings-frame";
import { useInstanceSettings } from "./use-instance-settings";
import { SettingsRow } from "./settings-rows";

/** What the form holds while it is being edited. */
interface SsoDraft {
  enabled: boolean;
  issuer: string;
  clientId: string;
  name: string;
  /** Typed secret. Empty leaves the stored one alone. */
  clientSecret: string;
  scopes: string;
  /** Comma separated, as the row shows them. */
  allowedDomains: string;
}

function draftOf(sso: SsoStatus): SsoDraft {
  return {
    enabled: sso.enabled,
    issuer: sso.issuer,
    clientId: sso.clientId,
    name: sso.name,
    clientSecret: "",
    scopes: sso.scopes.join(" "),
    allowedDomains: sso.allowedDomains.join(", "),
  };
}

function listOf(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The instance's identity provider, configured here rather than in `.env`.
 *
 * A company has one identity provider, so this is one provider: the issuer, the
 * client credentials registered there, and the domains a new account may come
 * from. The redirect URI is the one thing the identity provider needs back.
 */
export function SsoSection() {
  const [removeOpen, setRemoveOpen] = useState(false);

  const {
    status: sso,
    draft,
    loading,
    saving,
    removing,
    saveStatus,
    edit,
    save,
    remove,
  } = useInstanceSettings<SsoStatus, SsoDraft>({
    url: "/api/admin/sso",
    key: "sso",
    toDraft: draftOf,
    toPatch: (draft) => ({
      enabled: draft.enabled,
      issuer: draft.issuer.trim(),
      clientId: draft.clientId.trim(),
      name: draft.name.trim(),
      scopes: listOf(draft.scopes, /\s+/),
      allowedDomains: listOf(draft.allowedDomains, /[\s,]+/),
      ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    }),
  });

  const saveSso = async () => {
    const err = await save();
    if (err) toast.error(err.message || "Could not save the sign-on settings");
  };

  const removeSso = async () => {
    const err = await remove();
    setRemoveOpen(false);
    if (err) toast.error("Could not remove single sign-on");
    else toast.success("Single sign-on removed");
  };

  return (
    <AdminSettingsFrame
      loading={loading || !draft}
      saving={saving}
      status={saveStatus}
      onSave={() => void saveSso()}
    >
      {draft ? (
        <>
          <PageSection
            title="Provider"
            action={
              <Badge variant={sso?.configured ? "secondary" : "outline"} className="rounded-full">
                {sso?.configured ? "Ready" : "Not set up"}
              </Badge>
            }
          >
            <SettingsRow
              htmlFor="sso-enabled"
              label="Single sign-on"
              description="Switched off, the login page keeps to passwords even with a provider stored."
            >
              <Switch
                id="sso-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => edit({ enabled })}
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="sso-issuer"
              label="Issuer"
              description="The identity provider's issuer URL, e.g. https://login.example.com/tenant."
            >
              <Input
                id="sso-issuer"
                className="h-8 w-full sm:w-56"
                value={draft.issuer}
                onChange={(event) => edit({ issuer: event.target.value })}
                placeholder="https://login.example.com"
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="sso-client-id"
              label="Client ID"
              description="The application registered at the provider for this instance."
            >
              <Input
                id="sso-client-id"
                className="h-8 w-full sm:w-56"
                autoComplete="off"
                value={draft.clientId}
                onChange={(event) => edit({ clientId: event.target.value })}
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="sso-client-secret"
              label="Client secret"
              description={
                sso?.hasClientSecret
                  ? "A secret is stored. Type a new one to replace it."
                  : "Stored encrypted, and never sent back to this page."
              }
            >
              <Input
                id="sso-client-secret"
                type="password"
                className="h-8 w-full sm:w-56"
                autoComplete="new-password"
                value={draft.clientSecret}
                onChange={(event) => edit({ clientSecret: event.target.value })}
                placeholder={sso?.hasClientSecret ? "unchanged" : ""}
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="sso-name"
              label="Button label"
              description={`Shown on the login page. Empty shows "${SSO_DEFAULT_NAME}".`}
            >
              <Input
                id="sso-name"
                className="h-8 w-full sm:w-56"
                value={draft.name}
                onChange={(event) => edit({ name: event.target.value })}
                placeholder={SSO_DEFAULT_NAME}
              />
            </SettingsRow>
          </PageSection>

          <PageSection title="Accounts">
            <SettingsRow
              htmlFor="sso-domains"
              label="Allowed domains"
              description="Addresses at these domains get an account on first sign-in. Empty means only accounts an admin made can sign in."
            >
              <Input
                id="sso-domains"
                className="h-8 w-full sm:w-56"
                value={draft.allowedDomains}
                onChange={(event) => edit({ allowedDomains: event.target.value })}
                placeholder="example.com, example.org"
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="sso-scopes"
              label="Scopes"
              description="Asked for at sign-in. openid is added when it is missing."
            >
              <Input
                id="sso-scopes"
                className="h-8 w-full sm:w-56"
                value={draft.scopes}
                onChange={(event) => edit({ scopes: event.target.value })}
              />
            </SettingsRow>
          </PageSection>

          <PageSection title="Registration">
            <SettingsRow
              label="Redirect URI"
              description="Register this at the provider. Sign-in cannot come back without it."
            >
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground min-w-0 font-mono text-xs break-all">
                  {sso?.redirectUri}
                </span>
                <CopyButton
                  text={sso?.redirectUri ?? ""}
                  label="Copy the redirect URI"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                />
              </div>
            </SettingsRow>

            {sso?.discoveryUrl ? (
              <SettingsRow
                label="Discovery document"
                description="Read at sign-in to find the provider's endpoints."
              >
                <span className="text-muted-foreground min-w-0 font-mono text-xs break-all">
                  {sso.discoveryUrl}
                </span>
              </SettingsRow>
            ) : null}

            {sso?.configured ? (
              <SettingsRow
                label="Remove the provider"
                description="Forgets the issuer, the credentials and the domain list. The login page keeps to passwords."
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={removing}
                  onClick={() => setRemoveOpen(true)}
                >
                  Remove
                </Button>
              </SettingsRow>
            ) : null}
          </PageSection>

          <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove single sign-on?</AlertDialogTitle>
                <AlertDialogDescription>
                  The login page stops offering the provider, and accounts that only exist there
                  cannot sign in until it is set up again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => void removeSso()}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </AdminSettingsFrame>
  );
}
