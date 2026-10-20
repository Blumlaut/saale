"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { cn, ROW_ACTION } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, ExternalLink, Star } from "lucide-react";
import { plural } from "@/lib/format";
import { FaviconMark } from "./favicon-mark";
import { ToolStatusBadge } from "./tool-status-badge";
import type {
  ToolCardBlock,
  ToolCardModel,
  ToolRowLeading,
  ToolRowMark,
  ToolRowMeta,
  ToolRowModel,
  ToolTone,
} from "./tool-card-model";

/**
 * The one tool card.
 *
 * It renders a `ToolCardModel` and knows nothing about tools — no tool name
 * appears in this file, and it has no per-tool branch anywhere. Everything a
 * specific tool needs is expressed as data by its descriptor (see
 * `./tool-descriptors`), so a card cannot drift from the others in spacing,
 * badge styling, hover behaviour or how it expands.
 *
 * The body is closed until the user opens it, except where a descriptor asks
 * for `defaultOpen` (the result-shaped cards, whose rows are the answer).
 * A body-less model renders as a header-only row with no expander.
 */

/** Rows shown before the "show more" control, when a block doesn't say. */
const DEFAULT_ROW_MAX = 3;
/** Characters of a diff shown before scrolling. */
const DEFAULT_DIFF_MAX = 40;

export function ToolCard({ model, children }: { model: ToolCardModel; children?: ReactNode }) {
  const [open, setOpen] = useState(model.defaultOpen ?? false);
  const Icon = model.icon;
  const body = children ?? (model.blocks?.length ? <ToolBlocks blocks={model.blocks} /> : null);

  const header = (
    <>
      {body ? (
        open ? (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3 shrink-0" />
        )
      ) : null}
      <Icon className="text-muted-foreground size-3 shrink-0" />
      {/*
        The title is the card's identity, so it never truncates: the detail
        absorbs every pixel of pressure instead. That is only safe because a
        title is short by construction — a descriptor names a tool, and the
        generic card caps the name of a tool it has never seen.
      */}
      <span className="shrink-0 text-xs font-medium">{model.title}</span>
      {model.detail && (
        <span className="text-muted-foreground min-w-0 shrink-8 truncate font-mono text-xs">
          {model.detail}
        </span>
      )}
    </>
  );

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center">
        {body ? (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-lg px-3 py-2 text-xs font-normal"
          >
            {header}
          </Button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">{header}</div>
        )}

        <div className="flex shrink-0 items-center gap-1.5 pr-3">
          {model.action && (
            <Button variant="ghost" size="icon-xs" asChild>
              <a
                href={model.action.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={model.action.label}
              >
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
          <ToolStatusBadge status={model.status} />
        </div>
      </div>

      {body && open && <div className="border-border/30 space-y-1.5 border-t p-2">{body}</div>}
    </div>
  );
}

function ToolBlocks({ blocks }: { blocks: readonly ToolCardBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <ToolBlock key={index} block={block} />
      ))}
    </>
  );
}

function ToolBlock({ block }: { block: ToolCardBlock }) {
  switch (block.kind) {
    case "rows":
      return <ToolRows block={block} />;
    case "facts":
      return (
        <div className="space-y-1">
          {block.items.map((fact, index) => (
            <ToolFactLine key={index} fact={fact} />
          ))}
        </div>
      );
    case "output":
      return <ToolOutput block={block} />;
    case "diff":
      return <ToolDiff block={block} />;
    case "code":
      return <ToolCode block={block} />;
    case "text":
      return <ToolTextBlock block={block} />;
    case "badges":
      return (
        <div className="flex flex-wrap gap-1">
          {block.items.map((text) => (
            <Badge key={text} variant="secondary" className="rounded-full px-1.5 py-0 text-[10px]">
              {text}
            </Badge>
          ))}
        </div>
      );
  }
}

/** A list of rows, capped until expanded. */
function ToolRows({ block }: { block: Extract<ToolCardBlock, { kind: "rows" }> }) {
  const [expanded, setExpanded] = useState(false);
  const max = block.max ?? DEFAULT_ROW_MAX;
  const overflow = block.items.length - max;
  const visible = expanded ? block.items : block.items.slice(0, max);

  if (block.items.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-1 text-xs">{block.empty ?? "Nothing here"}</p>
    );
  }

  return (
    <div className="space-y-0.5">
      {visible.map((row, index) => (
        <ToolCardRow key={index} row={row} />
      ))}

      {overflow > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground w-full justify-center"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          {expanded ? "Show less" : `Show ${overflow} more`}
        </Button>
      )}
    </div>
  );
}

function ToolCardRow({ row }: { row: ToolRowModel }) {
  const linked = Boolean(row.href);

  const content = (
    <>
      {row.leading && <ToolRowLeadingView leading={row.leading} />}

      <div className="min-w-0 flex-1">
        {row.title && (
          <div className="flex items-center gap-1.5">
            <span className="text-foreground/90 truncate text-xs font-medium">{row.title}</span>
            {row.marks?.map((mark) => (
              <ToolRowMarkView key={mark} mark={mark} />
            ))}
          </div>
        )}

        {row.lines?.map((line, index) => (
          <p
            key={index}
            className={cn(
              "truncate text-xs",
              line.muted ? "text-muted-foreground/70" : "text-foreground/80",
              line.clamp && "line-clamp-1",
            )}
          >
            {line.text}
          </p>
        ))}

        {row.meta && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {row.meta.map((meta, index) => (
              <ToolRowMetaView key={index} meta={meta} />
            ))}
          </div>
        )}
      </div>

      {linked && (
        <ExternalLink
          className={cn("text-muted-foreground/50 mt-0.5 h-3.5 w-3.5 shrink-0", ROW_ACTION)}
        />
      )}
    </>
  );

  const className = cn(
    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
    row.accent && "border-l-2",
    linked && "group hover:bg-accent/60",
  );

  if (row.href) {
    return (
      <a
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        style={row.accent ? { borderLeftColor: row.accent } : undefined}
      >
        {content}
      </a>
    );
  }

  return (
    <div className={className} style={row.accent ? { borderLeftColor: row.accent } : undefined}>
      {content}
    </div>
  );
}

function ToolRowLeadingView({ leading }: { leading: ToolRowLeading }) {
  switch (leading.kind) {
    case "icon": {
      const Icon = leading.icon;
      return <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />;
    }
    case "avatar":
      return (
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white"
          style={{ backgroundColor: leading.color }}
        >
          {leading.label}
        </div>
      );
    case "favicon":
      return <FaviconMark url={leading.url} />;
  }
}

function ToolRowMarkView({ mark }: { mark: ToolRowMark }) {
  if (mark === "star") {
    return <Star className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />;
  }
  return <span className="bg-foreground/20 h-1.5 w-1.5 shrink-0 rounded-full" />;
}

function ToolRowMetaView({ meta }: { meta: ToolRowMeta }) {
  if (meta.kind === "badge") {
    return (
      <Badge
        variant="secondary"
        className={cn("rounded px-1 py-0 text-[10px] font-normal", toolToneClass(meta.tone))}
      >
        {meta.text}
      </Badge>
    );
  }

  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "text-muted-foreground/60 flex items-center gap-0.5 text-[10px]",
        meta.mono && "font-mono",
      )}
    >
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {meta.text}
    </span>
  );
}

function ToolFactLine({
  fact,
}: {
  fact: Extract<ToolCardBlock, { kind: "facts" }>["items"][number];
}) {
  const Icon = fact.icon;

  return (
    <div className="flex items-center gap-1.5">
      <Icon className="text-muted-foreground/60 h-3 w-3 shrink-0" />
      <span
        className={cn(
          "text-muted-foreground min-w-0 truncate text-[11px]",
          fact.mono && "font-mono",
        )}
      >
        {fact.text}
      </span>
      {fact.badge && (
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0 rounded px-1 py-0 text-[10px] font-normal",
            toolToneClass(fact.badge.tone),
          )}
        >
          {fact.badge.text}
        </Badge>
      )}
      {fact.note && (
        <span className="text-muted-foreground/60 shrink-0 text-[10px]">{fact.note}</span>
      )}
    </div>
  );
}

function ToolOutput({ block }: { block: Extract<ToolCardBlock, { kind: "output" }> }) {
  return (
    <div className="bg-muted rounded-lg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
      {block.stderr && <div className="text-red-700 dark:text-red-400/80">{block.stderr}</div>}
      {block.stdout && <div className="text-green-700 dark:text-green-400/80">{block.stdout}</div>}
    </div>
  );
}

function ToolDiff({ block }: { block: Extract<ToolCardBlock, { kind: "diff" }> }) {
  const max = block.max ?? DEFAULT_DIFF_MAX;
  const lines = block.lines.slice(0, max);
  const hidden = block.lines.length - lines.length;

  return (
    <div className="space-y-1">
      <div className="bg-muted max-h-40 overflow-auto rounded-lg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "whitespace-pre",
              line.startsWith("+") && "text-green-700 dark:text-green-400/80",
              line.startsWith("-") && "text-red-700 dark:text-red-400/80",
              !line.startsWith("+") && !line.startsWith("-") && "text-muted-foreground",
            )}
          >
            {line}
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <p className="text-muted-foreground/60 text-[10px]">
          {plural(hidden, "more line", "more lines")}
        </p>
      )}
    </div>
  );
}

function ToolCode({ block }: { block: Extract<ToolCardBlock, { kind: "code" }> }) {
  const text = block.max !== undefined ? block.text.slice(0, block.max) : block.text;

  return (
    <div className="space-y-1">
      {block.label && (
        <div className="text-muted-foreground text-xs font-medium">{block.label}</div>
      )}
      <pre
        className={cn(
          "bg-muted overflow-x-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap",
          block.tone === "danger" && "bg-red-500/10 text-red-600 dark:text-red-400",
        )}
      >
        {text}
        {text.length < block.text.length && "…"}
      </pre>
    </div>
  );
}

function ToolTextBlock({ block }: { block: Extract<ToolCardBlock, { kind: "text" }> }) {
  return (
    <p
      className={cn(
        "text-muted-foreground text-xs leading-relaxed",
        block.mono && "font-mono text-[11px]",
        block.clamp && "line-clamp-2",
        block.tone === "danger" && "text-red-600 dark:text-red-400",
      )}
    >
      {block.text}
    </p>
  );
}

/** Row and badge hues — the only place the tone names become classes. */
function toolToneClass(tone: ToolTone = "neutral"): string {
  switch (tone) {
    case "neutral":
      return "bg-muted text-muted-foreground";
    case "info":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "warn":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "danger":
      return "bg-red-500/10 text-red-600 dark:text-red-400";
    case "accent":
      return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
    case "violet":
      return "bg-violet-500/10 text-violet-600 dark:text-violet-400";
  }
}
