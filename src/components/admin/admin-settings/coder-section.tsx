"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageSection } from "@/components/layout/page";
import {
  ATTRIBUTION_VARIABLES,
  DEFAULT_ATTRIBUTION_LINE,
  MAX_ATTRIBUTION_LENGTH,
} from "@/lib/pi/commit-attribution";
import { SettingsRow } from "./settings-rows";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** What every commit a coder chat writes says about who wrote it. */
export function CoderSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [text, setText] = useState<string | null>(null);

  const attributionEnabled = enabled ?? settings?.commitAttributionEnabled ?? false;
  const attributionText = text ?? settings?.commitAttributionText ?? "";

  const saveAll = () =>
    void save({
      commitAttributionEnabled: attributionEnabled,
      commitAttributionText: attributionText.trim(),
    });

  return (
    <AdminSettingsFrame loading={loading} saving={saving} status={saveStatus} onSave={saveAll}>
      <PageSection title="Commits">
        <SettingsRow
          htmlFor="commit-attribution"
          label="Attribution trailer"
          description="Adds the line below to every commit a coder chat writes."
        >
          <Switch
            id="commit-attribution"
            checked={attributionEnabled}
            onCheckedChange={setEnabled}
          />
        </SettingsRow>
        <SettingsRow
          htmlFor="commit-attribution-line"
          label="Attribution line"
          description={`One trailer, on one line. A variable in it is filled in when the commit is made. Empty writes "${DEFAULT_ATTRIBUTION_LINE}".`}
        >
          <Input
            id="commit-attribution-line"
            value={attributionText}
            maxLength={MAX_ATTRIBUTION_LENGTH}
            onChange={(event) => setText(event.target.value)}
            placeholder={DEFAULT_ATTRIBUTION_LINE}
            className="h-8 w-full text-sm sm:w-64"
          />
        </SettingsRow>
        <div className="text-muted-foreground px-4 pb-3 text-xs">
          <p className="mb-1">The line can name these variables:</p>
          <ul className="space-y-0.5">
            {ATTRIBUTION_VARIABLES.map((variable) => (
              <li key={variable.name}>
                <code className="font-mono">${variable.name}</code>: {variable.what}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>
    </AdminSettingsFrame>
  );
}
