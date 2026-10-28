"use client";

import { useState } from "react";
import { ChevronLeft, Download, FileCode, X } from "lucide-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { FileBrowser } from "@/components/files/file-browser";
import { FileView } from "@/components/files/file-view";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { downloadFile } from "@/lib/download";
import { rawFileUrl } from "@/lib/files/urls";
import { cn } from "@/lib/utils";
import type { FileEntry } from "@/lib/files/types";

/** The browser's width, remembered per browser. */
const BROWSER_PANEL = {
  storageKey: "saale.files.browserWidth",
  label: "Resize the file browser",
  defaultWidth: 320,
  minWidth: 240,
  maxWidth: 560,
  handle: "right",
} as const;

/**
 * Files, as a workspace: the browser on one side and the editor on the
 * other.
 *
 * The same two components the coder panel uses, laid out for a whole page, so a
 * file opens wide instead of in a side column. A phone gets one of them at a
 * time. opening a file swaps the browser for the editor and the back arrow
 * swaps them back.
 */
export default function FilesPage() {
  const [entry, setEntry] = useState<FileEntry | null>(null);
  // Whether the open file holds text that is not on disk; the header says so.
  const [dirty, setDirty] = useState(false);
  const panel = useResizableWidth(BROWSER_PANEL);

  const open = (next: FileEntry) => {
    setDirty(false);
    setEntry(next);
  };

  return (
    <Page className="gap-0">
      <div className="flex min-h-0 flex-1 overflow-hidden md:gap-4">
        <div
          className={cn("min-h-0 flex-1 md:flex-none", entry && "hidden md:block")}
          style={{ width: panel.width }}
        >
          <FileBrowser
            target="user"
            onOpenFile={open}
            emptyHint="Files an agent writes and files you upload land here."
          />
        </div>

        {/* Drag to widen the browser; arrow keys do the same from the keyboard. */}
        <div
          {...panel.handleProps}
          className={cn(
            "group hover:bg-border focus-visible:ring-ring mx-1 hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none md:flex",
            panel.dragging && "bg-border",
          )}
        />

        <div className={cn("min-h-0 min-w-0 flex-1", !entry && "hidden md:flex")}>
          {entry ? (
            <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5 md:px-3">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to files"
                  className="h-6 w-6 shrink-0 md:hidden"
                  onClick={() => setEntry(null)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <p className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.path}>
                  {entry.name}
                </p>
                {dirty ? (
                  <span
                    title="Unsaved changes"
                    className="bg-primary size-1.5 shrink-0 rounded-full"
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Download ${entry.name}`}
                  className="h-6 w-6 shrink-0"
                  onClick={() => void downloadFile(rawFileUrl("user", entry.path, true))}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close the editor"
                  className="hidden h-6 w-6 shrink-0 md:inline-flex"
                  onClick={() => setEntry(null)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col p-2">
                <FileView target="user" entry={entry} onDirtyChange={setDirty} />
              </div>
            </GlassPanel>
          ) : (
            <GlassPanel className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileCode className="text-muted-foreground h-7 w-7" />
              <p className="text-sm font-medium">No file open</p>
              <p className="text-muted-foreground max-w-sm text-sm">
                Pick a file in the browser and it opens here.
              </p>
            </GlassPanel>
          )}
        </div>
      </div>
    </Page>
  );
}
