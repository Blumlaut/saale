"use client";

import { memo, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  Minus,
  MoreVertical,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchJson } from "@/lib/http";
import { isBinaryFile, previewKindFromPath } from "@/lib/editor/editor-utils";
import { cn, ROW_ACTION } from "@/lib/utils";
import { splitPath, statusStyle } from "./commit-files";
import { DiscardChangesDialog } from "./discard-dialog";
import { DiffImage } from "./diff-image";
import { CollapsibleSection } from "./collapsible-section";
import type { useGitActions } from "./use-git-actions";
import type { CoderChange } from "./use-coder-data";

/** One diff line's tint. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted/60 text-muted-foreground";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-300";
  return "";
}

/** The file row above the diff already names the file, so the header lines are noise. */
function diffBody(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < lines.length && !/^(--- |\+\+\+ |@@)/.test(lines[start] ?? "")) start += 1;
  return lines.slice(start).join("\n");
}

/** A diff's lines with the tint each one earns, worked out once per diff. */
function diffLines(diff: string): { text: string; className: string }[] {
  const body = diffBody(diff);
  if (!body.trim()) return [];
  return body.split("\n").map((line) => ({
    text: line || " ",
    className: cn("px-2 whitespace-pre", lineClass(line)),
  }));
}

/**
 * A unified diff in a box of its own, so a long line scrolls here.
 *
 * Memoised: the panel re-reads its worktree every 20 seconds, and a diff of
 * several thousand lines must not be rebuilt by a poll.
 */
export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  if (lines.length === 0) {
    return <p className="text-muted-foreground px-3 py-2 text-xs">No changes in this file.</p>;
  }

  return (
    <div className="bg-muted/40 mx-2 mb-2 max-h-80 overflow-auto rounded-lg font-mono text-[11px] leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className={line.className}>
          {line.text}
        </div>
      ))}
    </div>
  );
});

/** The status letter a git user reads in half a second. */
function statusLetter(change: CoderChange): { letter: string; className: string } {
  if (change.conflicted) return { letter: "!", className: "text-red-600 dark:text-red-400" };
  if (change.untracked) return { letter: "A", className: statusStyle("A") };
  if (change.originalPath) return { letter: "R", className: statusStyle("R") };
  return { letter: "M", className: statusStyle("M") };
}

function Counts({ change }: { change: CoderChange }) {
  if (change.added === null && change.deleted === null) return null;
  return (
    <span className="shrink-0 text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{change.added ?? 0}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{change.deleted ?? 0}</span>
    </span>
  );
}

/**
 * One changed path.
 *
 * The row opens its diff; the +/− beside it stages or unstages the path, and
 * discarding lives in the row's menu because it is the one action here that
 * cannot be undone.
 */
function ChangeRow({
  sessionId,
  change,
  group,
  actions,
  onDiscard,
}: {
  sessionId: string;
  change: CoderChange;
  group: "staged" | "unstaged";
  actions: ReturnType<typeof useGitActions>;
  onDiscard: (change: CoderChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const { dir, name } = splitPath(change.path);
  const status = statusLetter(change);
  const binary = isBinaryFile(change.path);
  const image = binary && previewKindFromPath(change.path) === "image";
  const busy = actions.isRunning("stage", change.path) || actions.isRunning("unstage", change.path);

  const loadDiff = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (diff !== null || binary) return;

    setLoadingDiff(true);
    setDiffError(null);
    const query = new URLSearchParams({ path: change.path });
    // An unstaged change is shown from the index down; a staged one from HEAD.
    if (group === "staged" && !change.unstaged) query.set("staged", "1");

    try {
      const body = await fetchJson<{ diff: string }>(
        `/api/coder/sessions/${encodeURIComponent(sessionId)}/diff?${query.toString()}`,
      );
      setDiff(body.diff);
    } catch (err) {
      console.error(`Failed to load the diff for ${change.path}:`, err);
      setDiffError(err instanceof Error ? err.message : "Could not read this diff.");
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div className="group">
      <div className="hover:bg-accent/60 flex items-center gap-1 pr-1 transition-colors">
        <button
          type="button"
          onClick={() => void loadDiff()}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
          title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
        >
          <span
            className={cn("w-3 shrink-0 text-center text-[11px] font-semibold", status.className)}
          >
            {status.letter}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs">{name}</span>
            <span className="text-muted-foreground block truncate font-mono text-[10px]">
              {dir}
              {change.conflicted ? " · conflict" : ""}
            </span>
          </span>
          <Counts change={change} />
        </button>

        <div className={cn("flex shrink-0 items-center gap-0.5", ROW_ACTION)}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6"
            disabled={actions.busy}
            aria-label={group === "staged" ? `Unstage ${name}` : `Stage ${name}`}
            title={group === "staged" ? "Unstage" : "Stage"}
            onClick={() =>
              void actions.run(
                group === "staged"
                  ? { action: "unstage", paths: [change.path] }
                  : { action: "stage", paths: [change.path] },
              )
            }
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : group === "staged" ? (
              <Minus className="h-3 w-3" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-6"
                  aria-label={`Actions for ${name}`}
                  disabled={actions.busy}
                />
              }
            >
              <MoreVertical className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {group === "staged" ? (
                <DropdownMenuItem
                  onClick={() => void actions.run({ action: "unstage", paths: [change.path] })}
                >
                  <Minus className="h-3.5 w-3.5" />
                  Unstage
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => void actions.run({ action: "stage", paths: [change.path] })}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Stage
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onDiscard(change)}>
                <Trash2 className="h-3.5 w-3.5" />
                {change.untracked ? "Delete file" : "Discard changes"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {open && (
        <div className="border-b">
          {loadingDiff && (
            <div className="flex items-center gap-2 px-3 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-muted-foreground text-xs">Reading diff…</span>
            </div>
          )}
          {diffError && (
            <p className="text-destructive px-3 py-2 text-xs break-words">{diffError}</p>
          )}
          {diff !== null && <DiffView diff={diff} />}
          {binary &&
            (image ? (
              <DiffImage sessionId={sessionId} path={change.path} />
            ) : (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                A binary file has no text to show.
              </p>
            ))}
          {change.conflicted && (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              git could not merge this file. Ask the agent to resolve it, or discard it to start
              over.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How many rows a section mounts before the rest wait for a click.
 *
 * A worktree missing its .gitignore lists tens of thousands of untracked paths,
 * and every row is a control with a menu.
 */
const CHANGE_PAGE = 100;

/** One section's rows, a page at a time. */
function ChangeRows({
  sessionId,
  changes,
  group,
  actions,
  onDiscard,
}: {
  sessionId: string;
  changes: CoderChange[];
  group: "staged" | "unstaged";
  actions: ReturnType<typeof useGitActions>;
  onDiscard: (change: CoderChange) => void;
}) {
  const [limit, setLimit] = useState(CHANGE_PAGE);
  const shown = changes.slice(0, limit);
  const hidden = changes.length - shown.length;

  return (
    <div className="flex flex-col">
      {shown.map((change) => (
        <ChangeRow
          key={change.path}
          sessionId={sessionId}
          change={change}
          group={group}
          actions={actions}
          onDiscard={onDiscard}
        />
      ))}
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground mx-2 my-1.5 gap-1.5 self-center"
          onClick={() => setLimit((value) => value + CHANGE_PAGE)}
        >
          <ChevronDown className="h-3 w-3" />
          Show {hidden} more
        </Button>
      )}
    </div>
  );
}

/** The line counts one group carries, next to its label. */
function counts(list: CoderChange[]) {
  const totals = list.reduce(
    (acc, change) => ({
      added: acc.added + (change.added ?? 0),
      deleted: acc.deleted + (change.deleted ?? 0),
    }),
    { added: 0, deleted: 0 },
  );
  return (
    <span className="shrink-0 text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{totals.deleted}</span>
    </span>
  );
}

/** A count and its section action, in the section header's right-hand corner. */
function SectionAction({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground hover:text-foreground h-5 px-1.5 text-[10px]"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/**
 * What changed in the worktree, split the way git sees it.
 *
 * Staged above changes: a commit only takes what is in the index, so the two
 * groups are separate lists rather than one with a label. A path that is both
 * appears in both, which is what it is.
 */
export function ChangeList({
  sessionId,
  changes,
  actions,
}: {
  sessionId: string;
  changes: CoderChange[];
  actions: ReturnType<typeof useGitActions>;
}) {
  const [discarding, setDiscarding] = useState<CoderChange[]>([]);
  const staged = changes.filter((change) => change.staged);
  const unstaged = changes.filter((change) => change.unstaged || change.untracked);

  return (
    <>
      {staged.length > 0 && (
        <CollapsibleSection
          label={`Staged · ${staged.length}`}
          right={counts(staged)}
          action={
            <SectionAction
              label="Unstage all"
              disabled={actions.busy}
              onClick={() => void actions.run({ action: "unstage" })}
            />
          }
        >
          <ChangeRows
            sessionId={sessionId}
            changes={staged}
            group="staged"
            actions={actions}
            onDiscard={(target) => setDiscarding([target])}
          />
        </CollapsibleSection>
      )}

      <CollapsibleSection
        label={`Changes · ${unstaged.length}`}
        right={counts(unstaged)}
        action={
          unstaged.length > 0 ? (
            <SectionAction
              label="Stage all"
              disabled={actions.busy}
              onClick={() => void actions.run({ action: "stage" })}
            />
          ) : undefined
        }
      >
        {unstaged.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3">
            <Check className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            <span className="text-muted-foreground text-xs">
              {staged.length > 0
                ? "Everything is staged."
                : "Worktree clean. All changes are committed."}
            </span>
          </div>
        ) : (
          <ChangeRows
            sessionId={sessionId}
            changes={unstaged}
            group="unstaged"
            actions={actions}
            onDiscard={(target) => setDiscarding([target])}
          />
        )}
      </CollapsibleSection>

      <DiscardChangesDialog
        changes={discarding}
        onOpenChange={(open) => !open && setDiscarding([])}
        onConfirm={async (targets) =>
          actions.run({ action: "discard", paths: targets.map((target) => target.path) })
        }
      />
    </>
  );
}

/** A stash, shown so the panel can say there is work set aside. */
export function StashHint({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 px-3 py-1.5 text-[11px]">
      <Undo2 className="h-3 w-3 shrink-0" />
      {count} stash{count === 1 ? "" : "es"} saved
    </p>
  );
}
