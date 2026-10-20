"use client";

import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { PanelLeft } from "lucide-react";
import { SessionSidebar } from "./session-sidebar";

/**
 * Mobile session list. icon trigger + sheet. The trigger is a bare span
 * (SheetTrigger renders the button) so it can sit inside header rows without
 * nesting interactive elements.
 */
export function MobileSessionSheet({
  activeSessionId,
  onNewChat,
}: {
  activeSessionId?: string;
  onNewChat?: () => void;
}) {
  return (
    <Sheet>
      <SheetTrigger aria-label="Open session list">
        <span className="hover:bg-accent/60 inline-flex h-8 w-8 items-center justify-center rounded transition-colors">
          <PanelLeft className="h-4 w-4" />
        </span>
      </SheetTrigger>
      <SheetContent side="left" className="w-4/5 max-w-[280px] p-0">
        <div className="h-full">
          <SessionSidebar
            {...(activeSessionId ? { activeSessionId } : {})}
            {...(onNewChat ? { onNewChat } : {})}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
