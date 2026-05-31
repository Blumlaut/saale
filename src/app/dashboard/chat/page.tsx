import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";

export default function ChatPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Chat</CardTitle>
          <CardDescription>Start a new conversation with Saale</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/dashboard/chat/new">
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              New Chat
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
