"use client";

import { SessionSidebar } from "@/components/chat/session-sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Active session ID is the segment after /chat/ (e.g. "abc-123")
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 ? segments[3] : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Header — rendered by each page */}

      {/* Content */}
      <div className="flex h-[calc(100vh-9rem)] gap-4 md:h-[calc(100vh-8rem)]">
        {/* Sidebar — desktop only */}
        <div className="hidden w-64 shrink-0 md:block">
          <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
        </div>

        {/* Mobile: session list in a sheet */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-white/10 dark:hover:bg-white/5">
                <PanelLeft className="h-4 w-4" />
              </span>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0 sm:w-80">
              <div className="h-full">
                <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Main area */}
        <div className="flex flex-1">{children}</div>
      </div>
    </div>
  );
}
