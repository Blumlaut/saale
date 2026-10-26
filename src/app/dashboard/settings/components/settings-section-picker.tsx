"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_LABELS,
  settingsSection,
  settingsSectionForPath,
  settingsSectionsInGroup,
} from "@/lib/navigation/settings-nav";
import { ArrowLeft, ChevronDown } from "lucide-react";

/**
 * Phone navigation for the settings area. The sidebar that holds the sections
 * on a desktop is hidden here, so the current section names itself and opens
 * the full list.
 */
export function SettingsSectionPicker() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const current = settingsSectionForPath(pathname) ?? settingsSection(DEFAULT_SETTINGS_SECTION);

  return (
    <div className="flex shrink-0 items-center gap-2 md:hidden">
      <Button
        variant="outline"
        size="icon"
        className="size-9 shrink-0"
        aria-label="Back"
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          className="border-border bg-card flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border px-3"
          aria-label={`Settings section: ${current.label}. Choose another`}
        >
          <span className="truncate text-sm font-medium">{current.label}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        </SheetTrigger>

        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Settings</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-6">
            {SETTINGS_GROUPS.map((group) => {
              const sections = settingsSectionsInGroup(group);
              if (sections.length === 0) return null;

              return (
                <div key={group}>
                  <p className="console-label px-1 pb-1">{SETTINGS_GROUP_LABELS[group]}</p>
                  <div className="space-y-0.5">
                    {sections.map((section) => (
                      <Link
                        key={section.id}
                        href={section.href}
                        onClick={() => setOpen(false)}
                        aria-current={current.id === section.id ? "page" : undefined}
                        className={cn(
                          "block rounded-lg px-2 py-2 transition-colors",
                          current.id === section.id
                            ? "bg-accent text-foreground"
                            : "hover:bg-accent/60",
                        )}
                      >
                        <span
                          className={cn(
                            "block text-sm",
                            current.id === section.id ? "font-medium" : "",
                          )}
                        >
                          {section.label}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {section.description}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
