import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function TasksPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Queue Tasks</CardTitle>
          <CardDescription>Automated AI tasks — coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Configure email summarization, classification, and spam filtering.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
