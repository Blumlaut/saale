"use client";

import { AlertTriangle } from "lucide-react";

/** A settings panel's failure line, above the controls it is about. */
export function SettingsError({ children }: { children: React.ReactNode }) {
  if (!children) return null;

  return (
    <p role="alert" className="text-destructive flex items-start gap-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </p>
  );
}
