"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

import { CopyButton } from "@/components/shared/copy-button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { commitUrl, type ChangelogItem, type ChangelogRelease } from "@/lib/changelog/parse";
import type { AppUpdate } from "@/hooks/use-app-update";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { fetchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
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

/** A release's version and date, with whatever marks it out from the others. */
function ReleaseHeader({
  version,
  date,
  marker,
}: {
  version: string;
  date: string;
  marker?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-sm font-medium">{version}</span>
        {marker}
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{date}</span>
    </div>
  );
}

/** One release's commits. Both the newest release and the shipped history use it. */
function ReleaseItems({ items }: { items: ChangelogItem[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {items.map((item) => (
        <li key={item.commit ?? item.text} className="flex gap-2 text-sm leading-relaxed">
          <span aria-hidden className="text-muted-foreground/40 select-none">
            -
          </span>
          <span className="text-foreground/90 min-w-0">
            {item.text}
            {item.commit && (
              <>
                {" "}
                <a
                  href={commitUrl(item.commit)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground/60 hover:text-foreground font-mono text-[11px]"
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

/** The release the instance could move to, and how. */
function UpdateEntry({ update }: { update: AppUpdate }) {
  const latest = update.latest;
  if (!latest) return null;

  return (
    <section className="pb-4">
      <ReleaseHeader version={latest.version} date={latest.date} />
      <span className="text-primary mt-1 block text-[10px] font-semibold tracking-[0.18em] uppercase">
        update available
      </span>

      <div className="bg-muted border-border mt-3 flex items-start gap-2 rounded-lg border p-3">
        <pre className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
          {UPGRADE_COMMANDS}
        </pre>
        <CopyButton
          text={UPGRADE_COMMANDS}
          label="Copy the update commands"
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
        />
      </div>

      {latest.items.length > 0 && <ReleaseItems items={latest.items} />}

      <a
        href={latest.url}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs"
      >
        Release notes on GitHub
        <ArrowUpRight className="size-3" aria-hidden />
      </a>
    </section>
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

  // The route behind `update` is admin-only; this keeps a caller from widening it.
  const isAdmin = useIsAdmin();
  const newer = isAdmin && update?.updateAvailable && update.latest ? update : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
          <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
            Changelog
          </SheetTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            Running <span className="font-mono">{APP_VERSION}</span>
          </p>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {newer && <UpdateEntry update={newer} />}

          {failed ? (
            <p className="text-muted-foreground text-sm">The changelog could not be loaded.</p>
          ) : releases === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : releases.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This build did not ship with a changelog.
            </p>
          ) : (
            <div className={cn("divide-border/40 divide-y", newer && "border-border/40 border-t")}>
              {releases.map((release) => (
                <section key={release.version} className="py-4 first:pt-0 last:pb-0">
                  <ReleaseHeader
                    version={release.version}
                    date={release.date}
                    marker={
                      release.version === APP_VERSION ? (
                        <Badge variant="outline" className="text-[10px]">
                          running
                        </Badge>
                      ) : null
                    }
                  />
                  <ReleaseItems items={release.items} />
                </section>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
