import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { ListTodo, Plus } from "lucide-react";

export default function TasksPage() {
  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Tasks</h1>
          <p className="text-muted-foreground mt-1 text-sm">Automated AI tasks</p>
        </div>
        <Button variant="secondary" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          New Task
        </Button>
      </div>

      {/* Empty state */}
      <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 duration-200">
        <GlassPanelContent>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
              <ListTodo className="text-muted-foreground/60 h-8 w-8" />
            </div>
            <h2 className="text-base font-medium">No tasks configured</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Configure email summarization, classification, and spam filtering.
            </p>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </>
  );
}
