import { ChatInterface } from "@/components/chat/chat-interface";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard/chat"
          className="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-white/10 dark:hover:bg-white/5"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Chat</h1>
        </div>
      </div>

      {/* Chat interface */}
      <ChatInterface sessionId={sessionId} />
    </>
  );
}
