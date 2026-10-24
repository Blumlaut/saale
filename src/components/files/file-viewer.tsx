"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { mimeTypeForName, previewKindFor } from "@/lib/files/mime";
import { rawFileUrl } from "@/lib/files/urls";
import { languageFromPath, previewKindFromPath, type PreviewKind } from "@/lib/editor/editor-utils";
import { formatRelativeDate } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import { formatFileSize } from "@/lib/utils";
import { FilePreview } from "./file-preview";
import type { FileEntry } from "@/lib/files/types";

// Monaco touches window at module scope; keep it out of the SSR bundle.
const MonacoView = dynamic(
  () => import("@/components/editor/monaco-view").then((m) => m.MonacoView),
  { ssr: false },
);

export interface FileViewerProps {
  target: string;
  /** The file to show; null closes the sheet. */
  entry: FileEntry | null;
  onClose: () => void;
}

type View = "code" | "preview";

/**
 * Read a file without leaving the workspace.
 *
 * Text files open in a Monaco view; markdown and HTML gain a rendered
 * preview, images and video play inline, and anything else offers the
 * download instead of pretending to render it. The bytes arrive through the
 * raw endpoint, which serves executable types as plain text. that is what
 * makes showing an agent-written HTML file here safe.
 */
export function FileViewer({ target, entry, onClose }: FileViewerProps) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const [view, setView] = useState<View>("code");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [binaryDetected, setBinaryDetected] = useState(false);

  const mimeKind = entry ? previewKindFor(entry.name, mimeTypeForName(entry.name)) : "binary";
  const previewKind = entry ? previewKindFromPath(entry.path) : null;
  const hasCode = mimeKind === "text";
  const hasPreview = previewKind !== null;
  const tooLarge = (entry?.size ?? 0) > MAX_PREVIEW_BYTES;
  const filePath = entry?.path ?? "";

  // A new file: reset state and pick the opening view. Media has no code
  // view; text opens in code even when it can also render. Deps are the file
  // identity, not the entry object, or a list refresh would reset the view.
  useEffect(() => {
    setView(hasCode ? "code" : hasPreview ? "preview" : "code");
    setText(null);
    setError("");
    setBinaryDetected(false);
  }, [target, filePath, hasCode, hasPreview]);

  useEffect(() => {
    if (!entry || !hasCode || tooLarge || view !== "code") {
      return;
    }
    if (text !== null) return;

    const controller = new AbortController();
    setLoading(true);
    setError("");

    void (async () => {
      try {
        const response = await fetch(rawFileUrl(target, entry.path), { signal: controller.signal });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not open this file (${response.status}).`);
        }
        const body = await response.text();
        // The extension says text, the bytes disagree: a NUL anywhere in the
        // first megabyte is not prose.
        if (body.slice(0, 1024 * 1024).includes("\u0000")) {
          setBinaryDetected(true);
          return;
        }
        setText(body);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("[file-viewer] failed to read file:", err);
        setError(err instanceof Error ? err.message : "Could not open this file.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [target, entry, hasCode, tooLarge, view, text]);

  const needsText = view === "code" || previewKind === "markdown" || previewKind === "html";
  const showSpinner = needsText && !error && text === null && loading;

  return (
    <Sheet open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[640px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 shrink-0 border-b px-6 pt-6 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-lg leading-tight font-semibold tracking-tight break-all">
                  {entry?.name ?? ""}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span>{entry ? formatFileSize(entry.size) : ""}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {entry ? formatRelativeDate(new Date(entry.modified).toISOString()) : ""}
                  </span>
                </SheetDescription>
                <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
                  {entry?.path}
                </p>
              </div>
              {entry && hasCode && hasPreview && (
                <Tabs value={view} onValueChange={(next) => setView(next as View)}>
                  <TabsList className="h-7">
                    <TabsTrigger value="code" className="text-xs">
                      Code
                    </TabsTrigger>
                    <TabsTrigger value="preview" className="text-xs">
                      Preview
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
            {entry ? (
              error ? (
                <p className="text-destructive text-sm">{error}</p>
              ) : tooLarge ? (
                <p className="text-muted-foreground text-sm">
                  This file is too large to show here ({entry ? formatFileSize(entry.size) : ""}).
                  Download it to read it.
                </p>
              ) : binaryDetected ? (
                <p className="text-muted-foreground text-sm">
                  This file cannot be shown here. Download it to open it.
                </p>
              ) : view === "preview" && hasPreview ? (
                showSpinner ? (
                  <CenterSpinner />
                ) : (
                  <FilePreview
                    target={target}
                    entry={entry}
                    kind={previewKind as PreviewKind}
                    content={text ?? undefined}
                  />
                )
              ) : view === "code" && hasCode ? (
                // Long lines scroll in this box rather than breaking every token.
                <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
                  {showSpinner ? (
                    <CenterSpinner />
                  ) : (
                    <MonacoView
                      key={filePath}
                      content={text ?? ""}
                      language={languageFromPath(filePath)}
                      theme={theme}
                    />
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  This file cannot be shown here. Download it to open it.
                </p>
              )
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t px-6 py-4">
            <Button
              className="w-full"
              onClick={() => entry && void downloadFile(rawFileUrl(target, entry.path, true))}
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

function CenterSpinner() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
    </div>
  );
}
