"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { fetchJson } from "@/lib/http";

export interface SessionLink {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string | null;
  lastTickAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  fireCount: number;
}

/**
 * Automations bound to the open conversation. the data behind the header's
 * Linked button and its panel/sheet.
 */
export function useSessionLinks(sessionId: string) {
  const [links, setLinks] = useState<SessionLink[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await fetchJson<{ watchers: SessionLink[] }>(
        `/api/chat/sessions/${sessionId}/automations`,
      );
      setLinks(data.watchers);
    } catch (err) {
      console.error("Failed to load session automations:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { links, reload };
}

/**
 * Whether a row's automation is running: a filled dot, or a ring for one that
 * is paused. The shape carries the state as well as the colour, so a reader
 * who cannot tell them apart still can.
 */
function StateDot({ enabled }: { enabled: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          enabled ? "bg-primary" : "border-muted-foreground/50 border",
        )}
      />
      <span className="sr-only">{enabled ? "Enabled" : "Paused"}</span>
    </>
  );
}

/** One automation, dense: what it is, how often it runs, and what it last said. */
function LinkRow({ link }: { link: SessionLink }) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <StateDot enabled={link.enabled} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium",
            !link.enabled && "text-muted-foreground",
          )}
        >
          {link.name}
        </span>
        {/* Which kind of thing this is; the dot beside the name carries the state. */}
        <Radar className="text-muted-foreground/40 h-3.5 w-3.5 shrink-0" />
      </div>
      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-3 text-[11px]">
        <span className="font-mono">{link.cronExpression ?? "manual"}</span>
        <span>· {link.lastTickAt ? formatRelativeDate(link.lastTickAt) : "never"}</span>
        <span>· {link.fireCount} fires</span>
      </div>
      {link.lastError && (
        <p className="text-destructive mt-1 pl-3 text-[11px] break-words">{link.lastError}</p>
      )}
    </div>
  );
}

/** The automations bound to the conversation, as the session panel lists them. */
export function SessionLinksContent({ links }: { links: SessionLink[] | null }) {
  if (links === null) {
    return <p className="text-muted-foreground px-2 py-3 text-xs">Loading…</p>;
  }
  if (links.length === 0) {
    return (
      <p className="text-muted-foreground px-2 py-3 text-xs">
        Nothing is linked to this conversation. An automation created in Jobs posts its results
        here.
      </p>
    );
  }
  return (
    <div>
      {links.map((link, i) => (
        <div key={link.id}>
          <LinkRow link={link} />
          {i < links.length - 1 && <Separator />}
        </div>
      ))}
    </div>
  );
}

/** The way out to where a binding is written, for the section's own header. */
export function AutomationsJobsLink() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground -mr-1 h-5 w-5"
      aria-label="Automations in Jobs"
      title="Automations in Jobs"
      onClick={() => router.push("/dashboard/jobs/automations")}
    >
      <ArrowUpRight className="h-3.5 w-3.5" />
    </Button>
  );
}
