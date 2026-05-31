import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Settings</CardTitle>
          <CardDescription>App configuration — coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Manage API keys, email accounts, model preferences, and more.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
