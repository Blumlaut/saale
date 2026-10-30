"use client";

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, ROW_ACTION } from "@/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";
import { Check, CheckSquare, Loader2, MoreVertical, Pin, PinOff, Trash2, Bot } from "lucide-react";

/**
 * One row of a chat list, shared by the chat sidebar and the coder panel.
 *
 * The two lists read different endpoints and add their own extras (a watcher
 * badge, a worktree branch, a message count), but a row opens, pins, selects
 * and deletes the same way in both, so that is written once here.
 */

/** Picking several chats at once. A list without it leaves this out. */
export interface ChatRowSelection {
  selecting: boolean;
  selected: boolean;
  toggle: () => void;
  start: () => void;
}

export interface ChatListRowProps {
  title: string;
  /** Second line: age, message count, branch, whatever this list shows. */
  subtitle: ReactNode;
  /** Icons and badges after the title: a spinner, a fork mark, a bot tag. */
  accessories?: ReactNode;
  active?: boolean;
  pinned?: boolean;
  /** Swaps the row menu's icon for a spinner while a delete runs. */
  deleting?: boolean;
  selection?: ChatRowSelection;
  onTogglePin?: () => void;
  onDelete: () => void;
  /** A row with an href is a link (prefetch, open in a new tab). */
  href?: string;
  /** A row without one is a button, and the host navigates here. */
  onOpen?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function ChatListRow({
  title,
  subtitle,
  accessories,
  active = false,
  pinned = false,
  deleting = false,
  selection,
  onTogglePin,
  onDelete,
  href,
  onOpen,
}: ChatListRowProps) {
  // Holding a row is the touch way into a selection; ctrl/⌘-click is the pointer
  // way, and the row menu offers a labelled path for anyone who finds neither.
  const hold = useLongPress(() => {
    if (!selection) return;
    if (selection.selecting) selection.toggle();
    else selection.start();
  });

  const handleActivate = (event: ReactMouseEvent<HTMLElement>) => {
    // The hold already acted on this gesture. the browser's click follows it.
    if (hold.consumeLongPress()) return;
    if (selection && (selection.selecting || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      selection.toggle();
      return;
    }
    if (!href) onOpen?.(event as ReactMouseEvent<HTMLButtonElement>);
  };

  const targetClassName = cn(
    "flex min-w-0 flex-1 items-center text-left",
    selection?.selecting ? "gap-2 px-1.5" : "pl-3",
  );

  // One target per row: while picking, the whole surface toggles, so a tap that
  // lands beside the box, or on the row's padding, still counts.
  const content = (
    <>
      {selection?.selecting && (
        <span
          aria-hidden
          data-slot="selection-indicator"
          className={cn(
            "border-input flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
            selection.selected && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {selection.selected && <Check className="size-3.5" strokeWidth={3} />}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col py-2">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{title}</span>
          {accessories}
          {pinned && <Pin className="text-muted-foreground h-3 w-3 shrink-0" />}
        </span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-2 truncate text-xs">
          {subtitle}
        </span>
      </span>
    </>
  );

  return (
    <div
      data-slot="session-row"
      className={cn(
        "group relative flex items-center gap-1 rounded-lg text-sm transition-colors duration-150 select-none",
        !selection?.selecting && "pr-1",
        selection?.selected ? "bg-primary/10" : active ? "bg-accent/70" : "hover:bg-accent/60",
      )}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      onContextMenu={hold.onContextMenu}
    >
      {href ? (
        <Link
          href={href}
          className={targetClassName}
          aria-pressed={selection ? selection.selected : undefined}
          onClick={handleActivate}
        >
          {content}
        </Link>
      ) : (
        <button
          className={targetClassName}
          aria-pressed={selection ? selection.selected : undefined}
          onClick={handleActivate}
        >
          {content}
        </button>
      )}
      {/* Delete lives behind the row menu: a permanent one-tap delete next to
          every row is too easy to hit while scrolling. */}
      {!selection?.selecting && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(triggerProps) => (
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", ROW_ACTION)}
                aria-label={`Actions for ${title}`}
                {...triggerProps}
              >
                {deleting ? <Loader2 className="animate-spin" /> : <MoreVertical />}
              </Button>
            )}
          />
          <DropdownMenuContent align="end" className="min-w-40">
            {onTogglePin && (
              <DropdownMenuItem onClick={onTogglePin}>
                {pinned ? <PinOff /> : <Pin />}
                {pinned ? "Unpin chat" : "Pin chat"}
              </DropdownMenuItem>
            )}
            {selection && (
              <DropdownMenuItem onClick={selection.start}>
                <CheckSquare />
                Select chat
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" disabled={deleting} onClick={onDelete}>
              <Trash2 />
              Delete chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * The pinned chats, stuck above the rest of the list with the divider that
 * separates them. Pinned rows leave the caller's own grouping, so age or a
 * folded card can never bury them again.
 */
export function PinnedChatGroup<T>({
  pinned,
  renderRows,
  hasRest,
  children,
}: {
  pinned: readonly T[];
  /** Draws the group's rows, so separators can follow the group's own order. */
  renderRows: (items: readonly T[]) => ReactNode;
  /** Whether anything follows, which is what the divider separates. */
  hasRest: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {pinned.length > 0 && (
        <>
          <p className="console-label text-muted-foreground px-3 pt-1 pb-0.5">Pinned</p>
          {renderRows(pinned)}
          {hasRest && <div className="border-border/40 my-1 border-t" />}
        </>
      )}
      {children}
    </>
  );
}

/** A watcher fire opened this chat rather than a person. */
export function WatcherChatBadge() {
  return (
    <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
      <Bot className="h-3 w-3" />
      Bot
    </Badge>
  );
}
