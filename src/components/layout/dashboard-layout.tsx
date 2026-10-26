"use client";

import { useTextFieldFocus } from "@/hooks/use-text-field-focus";

/**
 * The viewport-sized root of an authenticated area. It marks itself while a
 * text field has focus so the bottom bar can step aside for the phone keyboard
 * (see globals.css).
 */
export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const typing = useTextFieldFocus();

  return (
    <div className="dashboard-layout h-dvh overflow-hidden" data-text-field-focus={typing}>
      {children}
    </div>
  );
}
