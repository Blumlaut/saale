"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  FEATURES,
  FEATURE_DEFINITIONS,
  normalizeFeatureOverrides,
  type FeatureKey,
} from "@/lib/permissions/features";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** The feature switches every regular account starts with. */
export function FeaturesSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const defaults = draft ?? normalizeFeatureOverrides(settings?.featureDefaults);

  const toggle = (feature: FeatureKey, on: boolean) =>
    setDraft((prev) => ({ ...(prev ?? defaults), [feature]: on }));

  return (
    <AdminSettingsFrame
      loading={loading}
      saving={saving}
      status={saveStatus}
      onSave={() => void save({ featureDefaults: defaults })}
    >
      <p className="text-muted-foreground border-b px-4 py-3 text-xs">
        Regular accounts follow these switches. An account with its own switches keeps them. Admin
        accounts have every feature.
      </p>
      <div className="divide-y">
        {FEATURES.map((feature) => {
          const definition = FEATURE_DEFINITIONS[feature];
          return (
            <div key={feature} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <Label htmlFor={`feature-${feature}`} className="text-sm font-medium">
                  {definition.label}
                </Label>
                <p className="text-muted-foreground text-xs">{definition.description}</p>
              </div>
              <Switch
                id={`feature-${feature}`}
                checked={defaults[feature] ?? definition.defaultOn}
                onCheckedChange={(on) => toggle(feature, on)}
              />
            </div>
          );
        })}
      </div>
    </AdminSettingsFrame>
  );
}
