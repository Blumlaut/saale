"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageSection } from "@/components/layout/page";
import { postJson } from "@/lib/http";
import { MAIL_SECURITIES, type InstanceMailStatus } from "@/lib/email/mail-config";
import { AdminSettingsFrame } from "./settings-frame";
import { useInstanceSettings } from "./use-instance-settings";
import { NumberRow, SettingsRow } from "./settings-rows";

const SECURITY_LABELS: Record<string, string> = {
  starttls: "STARTTLS (587)",
  tls: "TLS (465)",
  none: "No encryption",
};

/** What the form holds while it is being edited. */
interface MailDraft {
  enabled: boolean;
  host: string;
  port: string;
  security: string;
  username: string;
  fromAddress: string;
  fromName: string;
  /** Typed password. Empty leaves the stored one alone. */
  password: string;
}

function draftOf(mail: InstanceMailStatus): MailDraft {
  return {
    enabled: mail.enabled,
    host: mail.host,
    port: String(mail.port),
    security: mail.security,
    username: mail.username,
    fromAddress: mail.fromAddress,
    fromName: mail.fromName,
    password: "",
  };
}

/**
 * The relay Saale sends its own mail through.
 *
 * Verification links and password resets leave through it, so this is what a
 * deployment configures before either can reach a person.
 */
export function MailSection() {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const {
    status: mail,
    draft,
    loading,
    saving,
    removing,
    saveStatus,
    edit,
    save,
    remove,
  } = useInstanceSettings<InstanceMailStatus, MailDraft>({
    url: "/api/admin/mail",
    key: "mail",
    toDraft: draftOf,
    toPatch: (draft) => ({
      enabled: draft.enabled,
      host: draft.host.trim(),
      port: Number(draft.port) || 587,
      security: draft.security,
      username: draft.username.trim(),
      fromAddress: draft.fromAddress.trim(),
      fromName: draft.fromName.trim(),
      ...(draft.password ? { password: draft.password } : {}),
    }),
    onApply: (next) => setTestTo((current) => current || next.fromAddress),
  });

  const saveMail = async () => {
    const err = await save();
    if (err) toast.error(err.message || "Could not save the mail settings");
  };

  const removeMail = async () => {
    const err = await remove();
    setRemoveOpen(false);
    if (err) toast.error("Could not remove the mail relay");
    else toast.success("Mail relay removed");
  };

  const sendTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await postJson("/api/admin/mail", { to: testTo.trim() });
      toast.success(`Test message sent to ${testTo.trim()}`);
    } catch (err) {
      console.error("Failed to send a test message through the instance mail relay:", err);
      setTestError((err as Error).message || "The relay refused the message");
    } finally {
      setTesting(false);
    }
  };

  return (
    <AdminSettingsFrame
      loading={loading || !draft}
      saving={saving}
      status={saveStatus}
      onSave={() => void saveMail()}
    >
      {draft ? (
        <>
          <PageSection
            title="Relay"
            action={
              <Badge variant={mail?.configured ? "secondary" : "outline"} className="rounded-full">
                {mail?.configured ? "Ready" : "Not set up"}
              </Badge>
            }
          >
            <SettingsRow
              htmlFor="mail-enabled"
              label="Send mail"
              description="Switched off, nothing leaves the instance even with a relay stored."
            >
              <Switch
                id="mail-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => edit({ enabled })}
              />
            </SettingsRow>

            <SettingsRow htmlFor="mail-security" label="Encryption">
              <Select
                value={draft.security}
                onValueChange={(security) => edit({ security: security ?? "starttls" })}
              >
                <SelectTrigger id="mail-security" className="h-8 w-full sm:w-40">
                  <SelectValue>{SECURITY_LABELS[draft.security]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MAIL_SECURITIES.map((security) => (
                    <SelectItem key={security} value={security}>
                      {SECURITY_LABELS[security]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>

            <SettingsRow
              htmlFor="mail-host"
              label="Host"
              description="The SMTP server, e.g. smtp.example.com."
            >
              <Input
                id="mail-host"
                className="h-8 w-full sm:w-56"
                value={draft.host}
                onChange={(event) => edit({ host: event.target.value })}
                placeholder="smtp.example.com"
              />
            </SettingsRow>

            <NumberRow
              id="mail-port"
              label="Port"
              description="587 with STARTTLS, 465 with TLS, 25 for a relay on the network."
              value={draft.port}
              onChange={(port) => edit({ port })}
              min={1}
              max={65535}
            />

            <SettingsRow
              htmlFor="mail-username"
              label="Username"
              description="Empty for a relay that takes no authentication."
            >
              <Input
                id="mail-username"
                className="h-8 w-full sm:w-56"
                autoComplete="off"
                value={draft.username}
                onChange={(event) => edit({ username: event.target.value })}
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="mail-password"
              label="Password"
              description={
                mail?.hasPassword
                  ? "A password is stored. Type a new one to replace it."
                  : "Paste the password the relay asks for."
              }
            >
              <Input
                id="mail-password"
                type="password"
                className="h-8 w-full sm:w-56"
                autoComplete="new-password"
                value={draft.password}
                onChange={(event) => edit({ password: event.target.value })}
                placeholder={mail?.hasPassword ? "unchanged" : ""}
              />
            </SettingsRow>
          </PageSection>

          <PageSection title="Sender">
            <SettingsRow
              htmlFor="mail-from"
              label="From address"
              description="The address mail is sent from. Most relays only accept one they own."
            >
              <Input
                id="mail-from"
                className="h-8 w-full sm:w-56"
                value={draft.fromAddress}
                onChange={(event) => edit({ fromAddress: event.target.value })}
                placeholder="saale@example.com"
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="mail-from-name"
              label="Display name"
              description="Shown beside the address. Empty uses the instance's name."
            >
              <Input
                id="mail-from-name"
                className="h-8 w-full sm:w-56"
                value={draft.fromName}
                onChange={(event) => edit({ fromName: event.target.value })}
              />
            </SettingsRow>
          </PageSection>

          <PageSection title="Test">
            <div className="space-y-3 px-4 py-3">
              <div className="space-y-2">
                <Label htmlFor="mail-test-to" className="text-sm font-medium">
                  Send a test message
                </Label>
                <p className="text-muted-foreground text-xs">
                  The relay answers with what it made of the credentials, which is the quickest way
                  to find a typo in a host or a password.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="mail-test-to"
                  className="h-8 w-full sm:w-64"
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                  placeholder="you@example.com"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={testing || !testTo.trim() || !mail?.configured}
                  onClick={() => void sendTest()}
                >
                  {testing ? "Sending..." : "Send test"}
                </Button>
              </div>

              {testError ? <p className="text-destructive text-xs">{testError}</p> : null}
            </div>

            {mail?.configured ? (
              <SettingsRow
                label="Remove the relay"
                description="Forgets the host, credentials and sender. Mail stops going out."
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
                <AlertDialogTitle>Remove the mail relay?</AlertDialogTitle>
                <AlertDialogDescription>
                  Verification links and password resets stop going out until a relay is configured
                  again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => void removeMail()}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </AdminSettingsFrame>
  );
}
