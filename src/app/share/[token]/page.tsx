import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { ShareViewer } from "@/components/chat/share-viewer";
import type { Message, ToolCallData } from "@/components/chat/types";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

interface ShareMessage {
  id: string;
  role: string;
  content: string;
  toolCalls: ToolCallData[] | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
  compaction?: { tokensBefore: number };
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;

  // Fetch shared session data (public endpoint)
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/chat/sessions/share/${token}/messages`, {
    cache: "no-store",
  });

  if (!res.ok) {
    notFound();
  }

  const data = await res.json();
  const rawMessages: ShareMessage[] = data.messages || [];
  const messages: Message[] = rawMessages.map((m) => ({
    id: m.id,
    role: m.role as Message["role"],
    content: m.content,
    thinking: undefined,
    toolCalls: m.toolCalls,
    parentMessageId: m.parentMessageId,
    createdAt: m.createdAt,
    attachments: undefined,
    ...(m.compaction && { compaction: m.compaction }),
  }));

  // Check if viewer is authenticated
  const session = await auth.api.getSession({ headers: await headers() });
  const isAuthenticated = !!session?.user;

  return (
    <ShareViewer
      token={token}
      sessionTitle={data.session.title}
      messages={messages}
      isAuthenticated={isAuthenticated}
    />
  );
}
