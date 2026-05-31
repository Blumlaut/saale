import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Mail, MailPlus } from "lucide-react";

export default function MailPage() {
  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Mail</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage your inbox</p>
        </div>
        <Button variant="secondary" size="sm">
          <MailPlus className="mr-2 h-4 w-4" />
          Compose
        </Button>
      </div>

      {/* Empty state */}
      <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 duration-200">
        <GlassPanelContent>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
              <Mail className="text-muted-foreground/60 h-8 w-8" />
            </div>
            <h2 className="text-base font-medium">No emails yet</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Connect your email accounts and let Saale manage your inbox.
            </p>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </>
  );
}
