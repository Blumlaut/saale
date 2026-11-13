"use client";

import { useState } from "react";
import { Download, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileView } from "@/components/files/file-view";
import { downloadFile } from "@/lib/download";
import { relativeToRoot } from "@/lib/files/paths";
import { rawFileUrl } from "@/lib/files/urls";
import type { FileEntry } from "@/lib/files/types";
import type { SessionPanelTab } from "./session-panel";

/**
 * The close control inside a tab.
 *
 * A span, because the trigger is the button and a button in a button is
 * invalid HTML.
 */
export function CloseTab({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <span
      role="button"
      aria-label={label}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="hover:bg-accent focus-visible:outline-ring -mr-1 rounded p-0.5 focus-visible:outline-1"
    >
      <X className="h-3 w-3" />
    </span>
  );
}

/** One file's bytes, its path and a way to save them. */
function FileTabContent({
  target,
  entry,
  rootPath,
  onDirtyChange,
}: {
  target: string;
  entry: FileEntry;
  /** The directory the path is shown relative to, the checkout's root. */
  rootPath?: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <p
          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
          title={entry.path}
        >
          {(rootPath ? relativeToRoot(rootPath, entry.path) : null) ?? entry.path}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Download ${entry.name}`}
          className="h-6 w-6 shrink-0"
          onClick={() => void downloadFile(rawFileUrl(target, entry.path, true))}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <FileView target={target} entry={entry} onDirtyChange={onDirtyChange} />
      </div>
    </div>
  );
}

export interface FileTab {
  /** The tab to put in the strip, or null while no file is open. */
  tab: SessionPanelTab | null;
  /**
   * Show one file. `root` is the directory its path reads from, for a caller
   * that only learns the root along with the file.
   */
  open: (entry: FileEntry, root?: string) => void;
  close: () => void;
  /** A file that holds text not yet on disk; its tab says so. */
  dirty: boolean;
}

/**
 * One file open as a tab beside the browser.
 *
 * The panel is the only surface the user can widen, and an editor needs the
 * room, so a file takes the whole tab rather than a row under the list.
 */
export function useFileTab({
  target,
  rootPath,
  onClose,
}: {
  /** The workspace handle the file endpoints resolve, `user`. */
  target: string;
  rootPath?: string;
  /** Runs when the tab's own close control is used, after the file is dropped. */
  onClose?: () => void;
}): FileTab {
  const [shown, setShown] = useState<{ entry: FileEntry; root?: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const entry = shown?.entry ?? null;
  const shownRoot = shown?.root ?? rootPath;

  const close = () => {
    setShown(null);
    setDirty(false);
  };

  const tab: SessionPanelTab | null = entry
    ? {
        id: "file",
        icon: <FileText className="h-3.5 w-3.5" />,
        pinIcon: true,
        ariaLabel: entry.name,
        label: <span className="hidden max-w-24 truncate @min-[280px]:inline">{entry.name}</span>,
        trailing: (
          <>
            {dirty ? (
              <span
                title="Unsaved changes"
                className="bg-primary inline-block size-1.5 shrink-0 rounded-full"
              />
            ) : null}
            <CloseTab
              label="Close the file tab"
              onClose={() => {
                close();
                onClose?.();
              }}
            />
          </>
        ),
        content: (
          <FileTabContent
            target={target}
            entry={entry}
            {...(shownRoot ? { rootPath: shownRoot } : {})}
            onDirtyChange={setDirty}
          />
        ),
      }
    : null;

  return {
    tab,
    open: (next: FileEntry, root?: string) => {
      setShown({ entry: next, ...(root ? { root } : {}) });
      setDirty(false);
    },
    close,
    dirty,
  };
}
