import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ChatSessionPage({ params }: { params: { sessionId: string } }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Chat Session</CardTitle>
          <CardDescription>
            Session {params.sessionId.slice(0, 8)} — coming soon
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            The chat interface with Pi streaming is being built.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
