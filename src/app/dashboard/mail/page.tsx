import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function MailPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Mail</CardTitle>
          <CardDescription>Email management — coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center text-sm">
            Connect your email accounts and let Saale manage your inbox.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
