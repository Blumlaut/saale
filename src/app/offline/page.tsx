"use client";

import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { WifiOff } from "lucide-react";

/**
 * Offline fallback.
 *
 * `public/sw.js` precaches this page — including the styles and fonts it
 * references — and serves it for any navigation that fails, so it must stay
 * free of network calls and authenticated data.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <GlassPanel className="w-full max-w-md">
        <GlassPanelContent className="space-y-4 text-center">
          <div className="bg-muted mx-auto flex h-12 w-12 items-center justify-center rounded-full">
            <WifiOff className="text-muted-foreground h-6 w-6" />
          </div>

          <div className="space-y-1">
            <h1 className="text-lg font-semibold">You&apos;re offline</h1>
            <p className="text-muted-foreground text-sm">
              Saale needs a connection to load your mail, chats and jobs. Check your network and try
              again.
            </p>
          </div>

          <Button onClick={() => window.location.reload()} className="w-full">
            Try again
          </Button>
        </GlassPanelContent>
      </GlassPanel>
    </main>
  );
}
