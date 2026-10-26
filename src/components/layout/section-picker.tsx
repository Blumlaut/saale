"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronDown } from "lucide-react";

export interface SectionPickerItem {
  id: string;
  href: string;
  label: string;
  /** One line under the label; the picker is roomy enough to explain. */
  description?: string;
}

export interface SectionPickerGroup {
  /** Group heading, omitted when the area has one flat list. */
  label?: string;
  items: readonly SectionPickerItem[];
}

/**
 * Phone navigation for an area whose sections live in the desktop sidebar.
 * The bar names the section you are on and opens the full list, so nothing has
 * to be duplicated into a tab strip above the content.
 */
export function SectionPicker({
  areaLabel,
  current,
  groups,
}: {
  /** Dialog title, e.g. "Settings". */
  areaLabel: string;
  current: SectionPickerItem;
  groups: SectionPickerGroup[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

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
          aria-label={`${areaLabel} section: ${current.label}. Choose another`}
        >
          <span className="truncate text-sm font-medium">{current.label}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        </SheetTrigger>

        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{areaLabel}</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-6">
            {groups.map((group, index) => (
              <div key={group.label ?? index}>
                {group.label ? (
                  <p className="text-muted-foreground px-2 pb-1 text-xs font-medium">
                    {group.label}
                  </p>
                ) : null}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.id}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={current.id === item.id ? "page" : undefined}
                      className={cn(
                        "block rounded-lg px-2 py-2 transition-colors",
                        current.id === item.id ? "bg-accent text-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <span
                        className={cn("block text-sm", current.id === item.id ? "font-medium" : "")}
                      >
                        {item.label}
                      </span>
                      {item.description ? (
                        <span className="text-muted-foreground block text-xs">
                          {item.description}
                        </span>
                      ) : null}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
