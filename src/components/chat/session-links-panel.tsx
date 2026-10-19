"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radar, X, ArrowUpRight } from "lucide-react";
import {
  GlassPanel,
  GlassPanelContent,
  GlassPanelFooter,
  GlassPanelHeader,
} from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/http";

export interface SessionLink {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  lastTickAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  fireCount: number;
}

/**
 * Watchers bound to the open conversation — the data behind the header's
 * Linked button and its panel/sheet.
 */
export function useSessionLinks(sessionId: string) {
  const [links, setLinks] = useState<SessionLink[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await fetchJson<{ watchers: SessionLink[] }>(
        `/api/chat/sessions/${sessionId}/watchers`,
      );
      setLinks(data.watchers);
    } catch (err) {
      console.error("Failed to load session watchers:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { links, reload };
}

function rel(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function LinkRow({ link }: { link: SessionLink }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Radar className={cn("h-4 w-4 shrink-0", link.enabled ? "" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{link.name}</span>
        <Badge variant={link.enabled ? "secondary" : "outline"}>
          {link.enabled ? "on" : "off"}
        </Badge>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 font-mono text-[11px]">
        <span>{link.cronExpression}</span>
        <span aria-hidden>·</span>
        <span>tick {rel(link.lastTickAt)}</span>
        <span aria-hidden>·</span>
        <span>{link.fireCount} fired</span>
      </div>
      {link.lastError && (
        <div className="mt-1.5 flex items-start gap-1.5 pl-6">
          <Badge variant="destructive" className="mt-px shrink-0">
            error
          </Badge>
          <span className="text-destructive/80 min-w-0 text-xs break-words">{link.lastError}</span>
        </div>
      )}
    </div>
  );
}

function SessionLinksContent({ links }: { links: SessionLink[] | null }) {
  if (links === null) {
    return <p className="text-muted-foreground px-4 py-6 text-sm">Loading…</p>;
  }
  if (links.length === 0) {
    return (
      <div className="px-4 py-6">
        <p className="text-sm">No watchers are linked to this conversation.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Create one in Jobs to have its results posted here.
        </p>
      </div>
    );
  }
  return (
    <div>
      {links.map((link, i) => (
        <div key={link.id}>
          <LinkRow link={link} />
          {i < links.length - 1 && <Separator className="px-4" />}
        </div>
      ))}
    </div>
  );
}

function LinksFooter() {
  const router = useRouter();
  return (
    <GlassPanelFooter className="justify-end px-4 py-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => router.push("/dashboard/jobs")}
      >
        Manage in Jobs
        <ArrowUpRight className="h-3 w-3" />
      </Button>
    </GlassPanelFooter>
  );
}

/** Desktop: inline panel sitting right of the conversation. */
export function SessionLinksPanel({
  links,
  onClose,
}: {
  links: SessionLink[] | null;
  onClose: () => void;
}) {
  return (
    <GlassPanel className="flex h-full w-full flex-col overflow-hidden rounded-none md:rounded-2xl">
      <GlassPanelHeader
        title="Linked"
        className="px-4 py-2 md:px-4 md:py-2.5"
        action={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{links?.length ?? 0}</Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close linked panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <GlassPanelContent className="min-h-0 flex-1 overflow-y-auto p-0">
        <SessionLinksContent links={links} />
      </GlassPanelContent>
      <LinksFooter />
    </GlassPanel>
  );
}

/** Mobile: the same content as a bottom sheet. */
export function SessionLinksSheet({
  links,
  open,
  onOpenChange,
}: {
  links: SessionLink[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] gap-0 p-0">
        <SheetHeader className="flex-row items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <SheetTitle>Linked</SheetTitle>
            <Badge variant="secondary">{links?.length ?? 0}</Badge>
          </div>
          <SheetDescription className="sr-only">
            Watchers linked to this conversation
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionLinksContent links={links} />
        </div>
        <LinksFooter />
      </SheetContent>
    </Sheet>
  );
}
