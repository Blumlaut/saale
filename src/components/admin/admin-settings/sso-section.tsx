import { Badge } from "@/components/ui/badge";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Page, PageScroll, PageSection } from "@/components/layout/page";
import { CopyButton } from "@/components/shared/copy-button";
import type { SsoStatus } from "@/lib/auth/sso";

/** One read-only line: what it is, then its value. */
function ValueRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 px-4 py-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="text-muted-foreground font-mono text-xs break-all">{children}</div>
    </div>
  );
}

/**
 * The instance's identity provider, as the deployment configured it.
 *
 * The credentials live in the environment, so nothing here is editable: the
 * page exists because a half-done setup shows up nowhere else, and because the
 * redirect URI has to be copied into the identity provider by hand.
 */
export function SsoSection({ status }: { status: SsoStatus }) {
  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageScroll>
          <PageSection
            title="Single sign-on"
            action={
              <Badge variant={status.enabled ? "secondary" : "outline"} className="rounded-full">
                {status.enabled ? "Available" : "Not set up"}
              </Badge>
            }
          >
            <div className="text-muted-foreground space-y-2 px-4 pb-3 text-xs">
              {status.enabled ? (
                <p>
                  The sign-in page offers a button for this provider. Accounts are created on first
                  sign-in only for an allowed domain; every other address needs an account an admin
                  made.
                </p>
              ) : (
                <p>
                  Set <code className="font-mono">SSO_OIDC_ISSUER</code>,{" "}
                  <code className="font-mono">SSO_OIDC_CLIENT_ID</code> and{" "}
                  <code className="font-mono">SSO_OIDC_CLIENT_SECRET</code> in{" "}
                  <code className="font-mono">.env</code>, then restart. The provider has to be
                  registered with the redirect URI below before anyone can sign in.
                </p>
              )}
            </div>

            <div className="divide-border/50 divide-y">
              <ValueRow label="Redirect URI">
                <div className="flex items-center justify-between gap-3">
                  <span>{status.redirectUri}</span>
                  <CopyButton
                    text={status.redirectUri}
                    label="Copy the redirect URI"
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  />
                </div>
              </ValueRow>

              {status.discoveryUrl ? (
                <ValueRow label="Discovery document">{status.discoveryUrl}</ValueRow>
              ) : null}

              <ValueRow label="Scopes">{status.scopes.join(" ")}</ValueRow>

              <ValueRow label="Allowed domains">
                {status.allowedDomains.length > 0
                  ? status.allowedDomains.join(", ")
                  : "None. Sign-in is for accounts that already exist."}
              </ValueRow>

              <ValueRow label="Button label">{status.name}</ValueRow>
            </div>
          </PageSection>
        </PageScroll>
      </GlassPanel>
    </Page>
  );
}
