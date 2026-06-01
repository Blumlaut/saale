import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ChatInterface } from "@/components/chat/chat-interface";

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Sidebar */}
      <div className="w-64 shrink-0">
        <SessionSidebar activeSessionId={sessionId} />
      </div>

      {/* Chat */}
      <ChatInterface sessionId={sessionId} />
    </div>
  );
}
