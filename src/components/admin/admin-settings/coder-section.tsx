"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageSection } from "@/components/layout/page";
import { ATTRIBUTION_CHAT_PLACEHOLDER, MAX_ATTRIBUTION_LENGTH } from "@/lib/pi/commit-attribution";
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
          description="Every commit a coder chat writes ends with the line below. The chat is told this in its prompt, so it decides the message it writes."
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
          description={`One trailer, on one line. ${ATTRIBUTION_CHAT_PLACEHOLDER} becomes the chat's id. Empty writes "Co-Authored-By: <workspace name>".`}
        >
          <Input
            id="commit-attribution-line"
            value={attributionText}
            maxLength={MAX_ATTRIBUTION_LENGTH}
            onChange={(event) => setText(event.target.value)}
            placeholder="Co-Authored-By: Saale ({chat})"
            className="h-8 w-full text-sm sm:w-64"
          />
        </SettingsRow>
      </PageSection>
    </AdminSettingsFrame>
  );
}
