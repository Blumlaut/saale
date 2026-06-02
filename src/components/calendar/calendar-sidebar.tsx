"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { CalendarDays } from "lucide-react";

interface CalendarAccount {
  id: string;
  name: string;
  enabled: boolean;
  calendars: Array<{
    id: string;
    name: string;
    color: string | null;
    enabled: boolean;
    eventCount: number;
  }>;
}

interface CalendarSidebarProps {
  accounts: CalendarAccount[];
}

export function CalendarSidebar({ accounts }: CalendarSidebarProps) {
  const totalEvents = accounts.reduce(
    (sum, acc) => sum + acc.calendars.reduce((c, cal) => c + cal.eventCount, 0),
    0,
  );

  // Upcoming events (next 24 hours)
  const upcoming = accounts
    .flatMap((acc) => acc.calendars)
    .filter((cal) => cal.enabled)
    .slice(0, 5);

  return (
    <div className="w-52 shrink-0 space-y-4">
      {/* Summary */}
      <GlassPanel>
        <GlassPanelContent className="space-y-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="text-muted-foreground h-4 w-4" />
            <span className="text-sm font-medium">
              {accounts.length} account{accounts.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">{totalEvents} total events</p>
        </GlassPanelContent>
      </GlassPanel>

      {/* Calendars */}
      <GlassPanel>
        <GlassPanelContent className="p-0">
          {accounts.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-muted-foreground text-xs">No accounts connected</p>
              <p className="text-muted-foreground/60 mt-1 text-[10px]">
                Add one in Settings → Calendar
              </p>
            </div>
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="truncate text-xs font-medium">{account.name}</span>
                  {!account.enabled && (
                    <span className="text-muted-foreground bg-muted/50 rounded-full px-1.5 py-0.5 text-[9px]">
                      off
                    </span>
                  )}
                </div>
                {account.calendars.map((cal) => (
                  <div key={cal.id} className="mt-1 flex items-center gap-1.5 pl-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: cal.color || "var(--muted-foreground)",
                      }}
                    />
                    <span className="text-muted-foreground truncate text-[11px]">{cal.name}</span>
                    <span className="text-muted-foreground/60 ml-auto text-[9px]">
                      {cal.eventCount}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </GlassPanelContent>
      </GlassPanel>

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <GlassPanel>
          <GlassPanelContent className="p-0">
            <div className="px-4 py-2">
              <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                Calendars
              </span>
            </div>
            {upcoming.map((cal) => (
              <div key={cal.id} className="flex items-center gap-2 px-4 py-1.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: cal.color || "var(--muted-foreground)" }}
                />
                <span className="truncate text-xs">{cal.name}</span>
              </div>
            ))}
          </GlassPanelContent>
        </GlassPanel>
      )}
    </div>
  );
}
