"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { commitUrl, type ChangelogRelease } from "@/lib/changelog/parse";
import { fetchJson } from "@/lib/http";
import { APP_VERSION } from "@/lib/version";

interface ChangelogResponse {
  version: string;
  releases: ChangelogRelease[];
}

/**
 * The changelog behind the version in the console footer. Fetched when it is
 * opened, so the console never pays for it on a page it is not shown on.
 */
export function ChangelogSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || releases || failed) return;

    let cancelled = false;
    fetchJson<ChangelogResponse>("/api/changelog")
      .then((data) => {
        if (!cancelled) setReleases(data.releases);
      })
      .catch((err: unknown) => {
        console.error("Failed to load the changelog:", err);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, releases, failed]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
          <SheetTitle>Changelog</SheetTitle>
          <SheetDescription>What changed in each release, newest first.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {failed ? (
            <p className="text-muted-foreground text-sm">The changelog could not be loaded.</p>
          ) : releases === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : releases.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This build did not ship with a changelog.
            </p>
          ) : (
            releases.map((release) => (
              <section
                key={release.version}
                className="border-border/40 border-b py-4 first:pt-0 last:border-b-0 last:pb-0"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{release.version}</span>
                  {release.version === APP_VERSION && (
                    <Badge variant="outline" className="text-[10px]">
                      running
                    </Badge>
                  )}
                  <span className="console-label ml-auto shrink-0">{release.date}</span>
                </div>

                <ul className="space-y-1.5">
                  {release.items.map((item) => (
                    <li
                      key={`${release.version}-${item.commit ?? item.text}`}
                      className="flex gap-2 text-sm"
                    >
                      <span aria-hidden className="text-muted-foreground/50 select-none">
                        -
                      </span>
                      <span className="min-w-0">
                        {item.text}
                        {item.commit && (
                          <>
                            {" "}
                            <a
                              href={commitUrl(item.commit)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-muted-foreground/70 hover:text-foreground font-mono text-xs"
                            >
                              {item.commit}
                            </a>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
