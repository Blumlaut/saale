"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { mimeTypeForName, previewKindFor } from "@/lib/files/mime";
import { formatRelativeDate } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import { formatFileSize } from "@/lib/utils";
import type { FileEntry } from "@/lib/files/types";

export interface FileViewerProps {
  target: string;
  /** The file to show; null closes the sheet. */
  entry: FileEntry | null;
  onClose: () => void;
}

/**
 * Read a file without leaving the workspace.
 *
 * Text comes back as text and images render inline; anything else offers the
 * download instead of pretending to render it. The bytes arrive through the raw
 * endpoint, which serves executable types as plain text — that is what makes
 * showing an agent-written HTML file here safe.
 */
export function FileViewer({ target, entry, onClose }: FileViewerProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const kind = entry ? previewKindFor(entry.name, mimeTypeForName(entry.name)) : "binary";
  const tooLarge = (entry?.size ?? 0) > MAX_PREVIEW_BYTES;
  const source = entry
    ? `/api/files/raw?${new URLSearchParams({ target, path: entry.path }).toString()}`
    : "";

  useEffect(() => {
    if (!entry || kind !== "text" || tooLarge) {
      setText(null);
      setError("");
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError("");
    setText(null);

    void (async () => {
      try {
        const response = await fetch(source, { signal: controller.signal });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not open this file (${response.status}).`);
        }
        setText(await response.text());
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not open this file.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [entry, kind, tooLarge, source]);

  return (
    <Sheet open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[640px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-lg leading-tight font-semibold tracking-tight break-all">
              {entry?.name ?? ""}
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span>{entry ? formatFileSize(entry.size) : ""}</span>
              <span aria-hidden>·</span>
              <span>{entry ? formatRelativeDate(new Date(entry.modified).toISOString()) : ""}</span>
            </SheetDescription>
            <p className="text-muted-foreground font-mono text-[11px] break-all">{entry?.path}</p>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
            {loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : error ? (
              <p className="text-destructive text-sm">{error}</p>
            ) : tooLarge ? (
              <p className="text-muted-foreground text-sm">
                This file is too large to show here ({entry ? formatFileSize(entry.size) : ""}).
                Download it to read it.
              </p>
            ) : kind === "image" ? (
              // Its own scroller: a wide image pans instead of stretching the sheet.
              <div className="min-h-0 flex-1 overflow-auto rounded-md border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={source} alt={entry?.name ?? ""} className="max-w-none" />
              </div>
            ) : kind === "binary" ? (
              <p className="text-muted-foreground text-sm">
                This file cannot be shown here. Download it to open it.
              </p>
            ) : (
              // Long lines scroll in this box rather than breaking every token.
              <div className="min-h-0 flex-1 overflow-auto rounded-md border">
                <pre className="w-max min-w-full p-3 font-mono text-xs leading-relaxed">
                  {text ?? ""}
                </pre>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t px-6 py-4">
            <Button
              className="w-full"
              onClick={() =>
                entry &&
                downloadFile(
                  `/api/files/raw?${new URLSearchParams({ target, path: entry.path, download: "1" }).toString()}`,
                )
              }
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
