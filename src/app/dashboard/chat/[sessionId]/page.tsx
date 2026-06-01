import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ChatInterface } from "@/components/chat/chat-interface";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PanelLeft } from "lucide-react";

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 md:h-[calc(100vh-7rem)]">
      {/* Sidebar — desktop only */}
      <div className="hidden w-64 shrink-0 md:block">
        <SessionSidebar activeSessionId={sessionId} />
      </div>

      {/* Mobile: session list in a sheet */}
      <div className="md:hidden">
        <Sheet>
          <SheetTrigger>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <PanelLeft className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0 sm:w-80">
            <div className="h-full">
              <SessionSidebar activeSessionId={sessionId} />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Chat */}
      <ChatInterface sessionId={sessionId} />
    </div>
  );
}
