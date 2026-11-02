"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageSection } from "@/components/layout/page";
import {
  clampMinPasswordLength,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password";
import { NumberRow, SettingsRow } from "./settings-rows";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** Who may sign up, how long a password has to be, and whether two-factor is required. */
export function SignupsSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();
  const [signups, setSignups] = useState<boolean | null>(null);
  const [minLength, setMinLength] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);

  const signupsEnabled = signups ?? settings?.signupsEnabled ?? true;
  const minPasswordLength = minLength ?? String(settings?.minPasswordLength ?? PASSWORD_MIN_LENGTH);
  const requireTwoFactor = twoFactor ?? settings?.requireTwoFactor ?? false;

  const saveAll = () =>
    void save({
      signupsEnabled,
      minPasswordLength: clampMinPasswordLength(Number(minPasswordLength)),
      requireTwoFactor,
    });

  return (
    <AdminSettingsFrame loading={loading} saving={saving} status={saveStatus} onSave={saveAll}>
      <PageSection title="Registration">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Label htmlFor="allow-signups" className="text-sm font-medium">
              Allow new registrations
            </Label>
            <p className="text-muted-foreground text-xs">
              New accounts cannot be created while this is off. The registration page says so.
            </p>
          </div>
          <Switch id="allow-signups" checked={signupsEnabled} onCheckedChange={setSignups} />
        </div>
      </PageSection>

      <PageSection title="Passwords">
        <NumberRow
          id="min-password-length"
          label="Minimum length"
          description={`Checked when an account is created and when a password changes. ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`}
          value={minPasswordLength}
          onChange={setMinLength}
          min={PASSWORD_MIN_LENGTH}
          max={PASSWORD_MAX_LENGTH}
        />
      </PageSection>

      <PageSection title="Two-factor">
        <SettingsRow
          htmlFor="require-two-factor"
          label="Require two-factor sign-in"
          description="An account with no authenticator app is held on the setup page until it has one."
        >
          <Switch
            id="require-two-factor"
            checked={requireTwoFactor}
            onCheckedChange={setTwoFactor}
          />
        </SettingsRow>
      </PageSection>
    </AdminSettingsFrame>
  );
}
