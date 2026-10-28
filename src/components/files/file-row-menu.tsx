"use client";

import { CheckSquare, Download, FileText, Pencil, Square, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { FileEntry } from "@/lib/files/types";

/** What a row's menu can do to an entry. */
export interface FileRowActions {
  openFile: (entry: FileEntry) => void;
  download: (entry: FileEntry) => void;
  rename: (entry: FileEntry) => void;
  remove: (entry: FileEntry) => void;
  toggleSelect: (entry: FileEntry) => void;
  selected: boolean;
  /** The workspace reports whether it allows these; a read-only target hides them. */
  canRename: boolean;
  canRemove: boolean;
}

/**
 * One row's menu items.
 *
 * Defined once because the same menu answers both the row's button and a right
 * click on the row; the two differ in the popup that draws them, not in what
 * they offer.
 */
export function FileRowMenuItems({
  entry,
  actions,
}: {
  entry: FileEntry;
  actions: FileRowActions;
}) {
  return (
    <>
      {entry.kind === "file" && (
        <DropdownMenuItem onClick={() => actions.openFile(entry)}>
          <FileText className="mr-2 h-3.5 w-3.5" />
          Open
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={() => actions.toggleSelect(entry)}>
        {actions.selected ? (
          <Square className="mr-2 h-3.5 w-3.5" />
        ) : (
          <CheckSquare className="mr-2 h-3.5 w-3.5" />
        )}
        {actions.selected ? "Deselect" : "Select"}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.download(entry)}>
        <Download className="mr-2 h-3.5 w-3.5" />
        {entry.kind === "file" ? "Download" : "Download as zip"}
      </DropdownMenuItem>
      {actions.canRename && (
        <DropdownMenuItem onClick={() => actions.rename(entry)}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
      )}
      {actions.canRemove && (
        <DropdownMenuItem variant="destructive" onClick={() => actions.remove(entry)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      )}
    </>
  );
}
