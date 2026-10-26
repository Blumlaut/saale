"use client";

import { usePathname } from "next/navigation";
import { SectionPicker, type SectionPickerItem } from "@/components/layout/section-picker";

/**
 * Frame for an area whose sections sit in the desktop sidebar: on a phone the
 * section picker takes its place above the content.
 */
export function SectionedAreaShell({
  areaLabel,
  sections,
  children,
}: {
  areaLabel: string;
  sections: readonly SectionPickerItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const fallback = sections[0];
  if (!fallback) throw new Error(`${areaLabel} has no sections`);

  const currentSection =
    sections.find(
      (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
    ) ?? fallback;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <SectionPicker
        areaLabel={areaLabel}
        current={currentSection}
        groups={[{ items: sections }]}
      />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
