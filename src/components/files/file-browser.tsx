"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { FileDeleteDialog } from "./file-delete-dialog";
import { FilePromptSheet } from "./file-prompt-sheet";
import { FileViewer } from "./file-viewer";
import { useFileBrowser } from "./use-file-browser";
import { downloadFile } from "@/lib/download";
import { relativeToRoot } from "@/lib/files/paths";
import { FULL_CAPABILITIES, type FileEntry } from "@/lib/files/types";
import { formatRelativeDate } from "@/lib/format";
import { cn, formatFileSize, ROW_ACTION } from "@/lib/utils";

export interface FileBrowserProps {
  /** Workspace token the API understands: `user`, or `council:<id>`. */
  target: string;
  /** Directory to open at, relative to the workspace root (a worktree). */
  rootPath?: string;
  /** Rendered first in the toolbar. e.g. a back link to the room. */
  leading?: ReactNode;
  /** What to say when the workspace is empty. */
  emptyHint?: ReactNode;
  /**
   * Tight rows, for a component dropped into a side panel: the panel's gutter
   * and the browser's own add up otherwise, and the list reads as a page.
   */
  dense?: boolean;
}

type PromptState = { mode: "folder" } | { mode: "rename"; entry: FileEntry };

/** Icon for a row, by kind and then by extension. */
function iconFor(entry: FileEntry) {
  if (entry.kind === "directory") return Folder;
  const name = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/.test(name)) return FileImage;
  if (/\.(zip|gz|tgz|tar|bz2|xz|7z|rar)$/.test(name)) return FileArchive;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|sh|sql|json|ya?ml|toml)$/.test(name)) {
    return FileCode;
  }
  if (/\.(md|txt|log|csv|ini|conf|env)$/.test(name)) return FileText;
  return FileIcon;
}

/**
 * Browse, download and manage a workspace.
 *
 * The component knows nothing about what it is browsing. it is handed a target
 * token and the server answers with a label, a root and the capabilities that
 * apply. That is what makes the same browser usable for a council's shared
 * workspace today and a user's own files next.
 *
 * Layout follows the console shell: one full-height panel whose first row is the
 * toolbar (context left, actions right, icon-only on phones) and whose list is
 * the only scroll region.
 */
export function FileBrowser({ target, rootPath, leading, emptyHint, dense }: FileBrowserProps) {
  const browser = useFileBrowser({ target, ...(rootPath ? { startPath: rootPath } : {}) });
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [deleting, setDeleting] = useState<FileEntry[]>([]);
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const listing = browser.listing;
  const root = listing?.target.root ?? "";
  const capabilities = listing?.target.capabilities ?? FULL_CAPABILITIES;
  const atRoot = Boolean(root) && browser.path === root;
  const entries = listing?.entries ?? [];
  const single = browser.selectedEntries.length === 1 ? browser.selectedEntries[0] : undefined;

  const crumbs = useMemo(() => {
    if (!listing) return [] as { name: string; path: string }[];
    const relative = relativeToRoot(listing.target.root, browser.path);
    const segments = (relative ?? "").split("/").filter(Boolean);
    return segments.map((name, index) => ({
      name,
      path: `${listing.target.root}/${segments.slice(0, index + 1).join("/")}`,
    }));
  }, [listing, browser.path]);

  const current = crumbs[crumbs.length - 1];

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.kind === "directory") browser.open(entry.path);
      else setViewing(entry);
    },
    [browser],
  );

  const downloadSelection = useCallback(() => {
    if (single?.kind === "file") downloadFile(browser.downloadUrl(single));
    else downloadFile(browser.zipUrl());
  }, [browser, single]);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!capabilities.upload) return;
      void browser.upload(Array.from(event.dataTransfer?.files ?? []));
    },
    [browser, capabilities.upload],
  );

  return (
    <GlassPanel
      className="relative flex h-full flex-col overflow-hidden border-0"
      onDragEnter={(event: DragEvent<HTMLDivElement>) => {
        if (!capabilities.upload) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        if (capabilities.upload) event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      {/* Toolbar. workspace context left, actions right, icon-only on phones */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b px-2 py-2",
          dense ? "md:px-2 md:py-1.5" : "md:px-4",
        )}
      >
        {leading}

        {!atRoot && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Up one folder"
            onClick={browser.up}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}

        <nav
          aria-label="Breadcrumb"
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {root && (
            <button
              type="button"
              onClick={() => browser.open(root)}
              className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors"
            >
              {listing?.target.label}
            </button>
          )}
          {crumbs.slice(0, -1).map((crumb) => (
            <span key={crumb.path} className="hidden shrink-0 items-center gap-1 md:flex">
              <ChevronRight className="text-muted-foreground h-3 w-3" aria-hidden />
              <button
                type="button"
                onClick={() => browser.open(crumb.path)}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {current && (
            <span className="flex min-w-0 items-center gap-1">
              <ChevronRight className="text-muted-foreground hidden h-3 w-3 md:block" aria-hidden />
              <span className="truncate text-xs font-medium">{current.name}</span>
            </span>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            onClick={browser.refresh}
          >
            <RefreshCw className={cn("h-4 w-4", browser.refreshing && "animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={browser.hideDotfiles ? "Show hidden files" : "Hide hidden files"}
            onClick={() => browser.setHideDotfiles(!browser.hideDotfiles)}
          >
            {browser.hideDotfiles ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {entries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Select all"
              onClick={browser.selectAll}
            >
              <FileText className="h-4 w-4" />
            </Button>
          )}
          {capabilities.createDirectory && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="New folder"
              onClick={() => setPrompt({ mode: "folder" })}
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
          )}
          {capabilities.upload && (
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 md:h-9"
              aria-label="Upload files"
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="h-4 w-4" />
              <span className="hidden md:inline">Upload</span>
            </Button>
          )}
        </div>
      </div>

      {/* Selection actions. only while something is selected */}
      {browser.selected.size > 0 && (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-b py-2",
            dense ? "px-2" : "px-4 md:px-6",
          )}
        >
          <span className="console-label">{browser.selected.size} selected</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={browser.clearSelection}
          >
            Clear
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" size="sm" className="h-8 gap-1.5" onClick={downloadSelection}>
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">
                {single?.kind === "file" ? "Download" : "Download zip"}
              </span>
            </Button>
            {capabilities.remove && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setDeleting(browser.selectedEntries)}
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden md:inline">Delete</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* The list scrolls here. the only scroll region */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          browser.refreshing && "pointer-events-none opacity-60 transition-opacity",
        )}
      >
        {browser.loading && !listing ? (
          <div className={cn("flex items-center justify-center", dense ? "py-6" : "py-10")}>
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : browser.error && !listing ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-2 text-center",
              dense ? "px-2 py-6" : "px-4 py-12",
            )}
          >
            <p className="text-destructive text-sm">{browser.error}</p>
            <Button type="button" size="sm" variant="secondary" onClick={browser.refresh}>
              Try again
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-2 text-center",
              dense ? "px-2 py-8" : "px-4 py-14",
            )}
          >
            <Folder className="text-muted-foreground h-5 w-5" />
            <p className="text-muted-foreground text-sm">Nothing here yet.</p>
            {emptyHint && <p className="text-muted-foreground max-w-sm text-xs">{emptyHint}</p>}
          </div>
        ) : (
          entries.map((entry, index) => {
            const Icon = iconFor(entry);
            const selected = browser.selected.has(entry.path);

            return (
              <div key={entry.path}>
                <div
                  className={cn(
                    "group hover:bg-accent/60 flex items-center transition-colors",
                    dense ? "gap-2 px-2 py-0.5" : "gap-3 px-4 py-2.5 md:px-6",
                    selected && "bg-accent/70",
                  )}
                >
                  <Checkbox
                    checked={selected}
                    aria-label={`Select ${entry.name}`}
                    className={cn("shrink-0", ROW_ACTION)}
                    onCheckedChange={() => browser.toggle(entry)}
                  />

                  <button
                    type="button"
                    onClick={(event) => {
                      // Modifier-clicks select instead of opening, the way a file
                      // list is expected to behave.
                      if (event.shiftKey || event.metaKey || event.ctrlKey) {
                        browser.toggle(entry, { range: event.shiftKey });
                        return;
                      }
                      openEntry(entry);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Icon
                      className={cn(
                        "text-muted-foreground shrink-0",
                        dense ? "h-3.5 w-3.5" : "h-4 w-4",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn("block truncate font-medium", dense ? "text-xs" : "text-sm")}
                      >
                        {entry.name}
                      </span>
                      <span
                        className={cn(
                          "text-muted-foreground block truncate md:hidden",
                          dense ? "text-[11px]" : "text-xs",
                        )}
                      >
                        {entry.kind === "file" ? formatFileSize(entry.size) : "Folder"}
                      </span>
                    </span>
                  </button>

                  <span
                    className={cn(
                      "text-muted-foreground hidden shrink-0 md:block",
                      dense ? "text-[11px]" : "text-xs",
                    )}
                  >
                    {entry.kind === "file" ? formatFileSize(entry.size) : ""}
                  </span>
                  <span
                    className={cn(
                      "text-muted-foreground hidden shrink-0 lg:block",
                      dense ? "text-[11px]" : "text-xs",
                    )}
                  >
                    {formatRelativeDate(new Date(entry.modified).toISOString())}
                  </span>

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={(triggerProps) => (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className={cn("shrink-0", dense && "h-6 w-6", ROW_ACTION)}
                          aria-label={`Actions for ${entry.name}`}
                          {...triggerProps}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      )}
                    />
                    <DropdownMenuContent align="end">
                      {entry.kind === "file" && (
                        <DropdownMenuItem onClick={() => setViewing(entry)}>
                          <FileText className="mr-2 h-3.5 w-3.5" />
                          Preview
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() =>
                          downloadFile(
                            entry.kind === "file"
                              ? browser.downloadUrl(entry)
                              : browser.zipUrlFor([entry]),
                          )
                        }
                      >
                        <Download className="mr-2 h-3.5 w-3.5" />
                        {entry.kind === "file" ? "Download" : "Download as zip"}
                      </DropdownMenuItem>
                      {capabilities.rename && (
                        <DropdownMenuItem onClick={() => setPrompt({ mode: "rename", entry })}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          Rename
                        </DropdownMenuItem>
                      )}
                      {capabilities.remove && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleting([entry])}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {index < entries.length - 1 && <Separator />}
              </div>
            );
          })
        )}
      </div>

      {listing?.truncated && (
        <p
          className={cn(
            "text-muted-foreground shrink-0 border-t py-2 text-xs",
            dense ? "px-2" : "px-4 md:px-6",
          )}
        >
          Showing the first {entries.length} entries of this folder.
        </p>
      )}

      {/* Drop target hint */}
      {dragging && (
        <div className="bg-background/70 pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="border-border bg-popover rounded-md border px-4 py-2 text-sm shadow-sm">
            Drop files to upload
          </p>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void browser.upload(files);
        }}
      />

      <FileViewer target={target} entry={viewing} onClose={() => setViewing(null)} />

      <FilePromptSheet
        open={prompt !== null}
        onOpenChange={(open) => !open && setPrompt(null)}
        title={prompt?.mode === "rename" ? "Rename" : "New folder"}
        description={
          prompt?.mode === "rename"
            ? "The entry stays in this folder."
            : "Created in the folder you are looking at."
        }
        label={prompt?.mode === "rename" ? "New name" : "Folder name"}
        submitLabel={prompt?.mode === "rename" ? "Rename" : "Create folder"}
        initialValue={prompt?.mode === "rename" ? prompt.entry.name : ""}
        onSubmit={(value) =>
          prompt?.mode === "rename"
            ? browser.rename(prompt.entry, value)
            : browser.createFolder(value)
        }
      />

      <FileDeleteDialog
        entries={deleting}
        onOpenChange={(open) => !open && setDeleting([])}
        onConfirm={browser.remove}
      />
    </GlassPanel>
  );
}
