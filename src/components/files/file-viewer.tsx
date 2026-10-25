"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { rawFileUrl } from "@/lib/files/urls";
import { formatRelativeDate } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import { formatFileSize } from "@/lib/utils";
import { FileView } from "./file-view";
import type { FileEntry } from "@/lib/files/types";

export interface FileViewerProps {
  target: string;
  /** The file to show; null closes the sheet. */
  entry: FileEntry | null;
  onClose: () => void;
}

/**
 * Read a file without leaving the workspace, in a sheet.
 *
 * Pages without a panel of their own open files this way. The coder chat has a
 * resizable worktree panel, so there a file is a tab in that panel instead.
 */
export function FileViewer({ target, entry, onClose }: FileViewerProps) {
  return (
    <Sheet open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[640px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 shrink-0 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-lg leading-tight font-semibold tracking-tight break-all">
              {entry?.name ?? ""}
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span>{entry ? formatFileSize(entry.size) : ""}</span>
              <span aria-hidden>·</span>
              <span>{entry ? formatRelativeDate(new Date(entry.modified).toISOString()) : ""}</span>
            </SheetDescription>
            <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
              {entry?.path}
            </p>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
            {entry ? <FileView target={target} entry={entry} /> : null}
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
