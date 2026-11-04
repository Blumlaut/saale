"use client";

import { useEffect, useState } from "react";

import { CopyButton } from "@/components/shared/copy-button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { commitUrl, type ChangelogItem, type ChangelogRelease } from "@/lib/changelog/parse";
import type { AppUpdate } from "@/hooks/use-app-update";
import { fetchJson } from "@/lib/http";
import { APP_VERSION } from "@/lib/version";

interface ChangelogResponse {
  version: string;
  releases: ChangelogRelease[];
}

/** What `docs/install.md` tells an operator to run, and the only way this moves. */
const UPGRADE_COMMANDS = [
  "docker compose -f docker-compose.prod.yml pull",
  "docker compose -f docker-compose.prod.yml up -d",
].join("\n");

/** One release's commits. Both the newest release and the shipped history use it. */
function ReleaseItems({ items }: { items: ChangelogItem[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.commit ?? item.text} className="flex gap-2 text-sm">
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
  );
}

/** The changelog behind the version in the console footer. Fetched on open. */
export function ChangelogSheet({
  open,
  onOpenChange,
  update,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The newest published release, when the footer already looked one up. */
  update: AppUpdate | null;
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

  const newer = update?.updateAvailable ? update.latest : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
          <SheetTitle>Changelog</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {newer && update && (
            <section className="border-border/40 border-b py-4 first:pt-0">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{newer.version}</span>
                <Badge className="text-[10px]">update available</Badge>
                {newer.date && <span className="console-label ml-auto shrink-0">{newer.date}</span>}
              </div>

              {newer.items.length > 0 && <ReleaseItems items={newer.items} />}

              <div className="bg-muted border-border mt-3 flex items-start gap-2 rounded-xl border p-2.5">
                <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-relaxed">
                  {UPGRADE_COMMANDS}
                </pre>
                <CopyButton
                  text={UPGRADE_COMMANDS}
                  label="Copy the update commands"
                  className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                />
              </div>

              <p className="text-muted-foreground mt-2 text-xs">
                You are on {update.current}. A pinned SAALE_VERSION stays where it is until you
                change it.
              </p>

              <a
                href={newer.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-4"
              >
                Release notes on GitHub
              </a>
            </section>
          )}

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

                <ReleaseItems items={release.items} />
              </section>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
