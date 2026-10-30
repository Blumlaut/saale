"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";
import { streamBlocks } from "@/lib/chat/stream-blocks";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Markdown Renderer. liquid glass styling for every element        */
/* ------------------------------------------------------------------ */

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * Treat single newlines as line breaks (GFM "hard break") instead of
   * merging them. For typed chat input; LLM output writes real markdown
   * line structure and stays on the default.
   */
  hardBreaks?: boolean;
}

/**
 * Built once: `react-markdown` creates its processor on every render, so an
 * array assembled in the component would be a new pipeline each time.
 */
const REMARK_PLUGINS: PluggableList = [remarkGfm];
const REMARK_PLUGINS_HARD_BREAKS: PluggableList = [remarkBreaks, remarkGfm];
const REHYPE_PLUGINS: PluggableList = [
  [rehypeHighlight, { detect: true, ignoreMissing: true, placeholderLanguage: "text" }],
];

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  hardBreaks = false,
}: MarkdownRendererProps) {
  return (
    <div className={cn("markdown-body text-sm leading-relaxed", className)}>
      <MarkdownDocument content={content} hardBreaks={hardBreaks} />
    </div>
  );
});

/** One markdown document, without the wrapper around it. */
const MarkdownDocument = memo(function MarkdownDocument({
  content,
  hardBreaks = false,
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={hardBreaks ? REMARK_PLUGINS_HARD_BREAKS : REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

/** A block that has stopped changing, so it parses once and stays put. */
const StreamBlock = memo(function StreamBlock({ content }: { content: string }) {
  return <MarkdownDocument content={content} />;
});

/**
 * Markdown whose text is still arriving.
 *
 * Renders one document per block with everything but the last memoized, so a
 * message growing into thousands of characters only pays for the block being
 * written (see `lib/chat/stream-blocks`).
 */
export function StreamingMarkdown({ content, className }: MarkdownRendererProps) {
  const blocks = streamBlocks(content);

  return (
    <div className={cn("markdown-body text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => (
        <StreamBlock key={index} content={block} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Code block with copy button                                       */
/* ------------------------------------------------------------------ */

const COPY_RESET_MS = 2000;

function CodeBlock({ children, className, ...rest }: React.ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    // innerText reflects rendered text; jsdom only implements textContent.
    const text = preRef.current?.innerText ?? preRef.current?.textContent;
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch (err) {
      console.error("Failed to copy code to clipboard:", err);
    }
  };

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-xl last:mb-0">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Code copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className="absolute top-2 right-2 z-10 rounded-md bg-white/10 p-1.5 text-gray-300 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-white/20 focus-visible:opacity-100 any-pointer-coarse:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre
        ref={preRef}
        className={cn(
          "overflow-x-auto bg-[#1e1e2e] p-4 font-mono text-xs leading-relaxed text-gray-200",
          className,
        )}
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component overrides                                               */
/* ------------------------------------------------------------------ */

const COMPONENTS = {
  /* ---- Headings ---- */
  h1: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className={cn(
        "mt-6 mb-3 text-lg leading-tight font-semibold tracking-tight first:mt-0",
        className,
      )}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className={cn("mt-5 mb-2 text-base leading-snug font-medium first:mt-0", className)}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className={cn("mt-4 mb-2 text-sm leading-snug font-medium first:mt-0", className)}
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className={cn("mt-4 mb-1 text-sm leading-snug font-medium first:mt-0", className)}
      {...props}
    >
      {children}
    </h4>
  ),

  /* ---- Paragraphs ---- */
  p: ({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className={cn("mb-3 leading-relaxed last:mb-0", className)} {...props}>
      {children}
    </p>
  ),

  /* ---- Links ---- */
  a: ({ className, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      className={cn(
        "text-primary decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current",
        className,
      )}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),

  /* ---- Strong / Emphasis ---- */
  strong: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className={cn("font-semibold", className)} {...props}>
      {children}
    </strong>
  ),
  em: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <em className={cn("italic", className)} {...props}>
      {children}
    </em>
  ),

  /* ---- Inline code ---- */
  code: (props: React.ComponentProps<"code">) => {
    const { className, children, ...rest } = props;
    /* Block code is rendered via pre > code; this handles inline only */
    return (
      <code
        className={cn(
          "bg-muted/50 text-foreground rounded-md px-1.5 py-0.5 font-mono text-xs",
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },

  /* ---- Code block (pre wrapping code) ---- */
  pre: (props: React.ComponentProps<"pre">) => <CodeBlock {...props} />,

  /* ---- Blockquote ---- */
  blockquote: ({ className, children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className={cn("border-muted-foreground/40 text-muted-foreground border-l-2 pl-4", className)}
      {...props}
    >
      {children}
    </blockquote>
  ),

  /* ---- Horizontal rule ---- */
  hr: ({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) => (
    <hr className={cn("border-muted-foreground/15 my-5", className)} {...props} />
  ),

  /* ---- Images ---- */
  img: ({ className, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element -- markdown content, not static assets
    <img
      className={cn("mx-auto my-3 max-w-full rounded-xl", className)}
      alt={alt || ""}
      {...props}
    />
  ),

  /* ---- Tables ---- */
  table: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="border-border/40 bg-muted my-4 overflow-x-auto rounded-xl border">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead className={cn(className)} {...props}>
      {children}
    </thead>
  ),
  tbody: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody className={cn(className)} {...props}>
      {children}
    </tbody>
  ),
  tr: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr
      className={cn("border-border/20 border-b transition-colors last:border-b-0", className)}
      {...props}
    >
      {children}
    </tr>
  ),
  th: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableHeaderCellElement>) => (
    <th
      className={cn(
        "border-border/30 text-foreground bg-card border-b px-4 py-2.5 font-medium",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ className, children, ...props }: React.HTMLAttributes<HTMLTableDataCellElement>) => (
    <td className={cn("text-muted-foreground px-4 py-2.5", className)} {...props}>
      {children}
    </td>
  ),

  /* ---- Lists ---- */
  ul: ({ className, children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className={cn("mb-3 list-disc pl-5 leading-relaxed last:mb-0", className)} {...props}>
      {children}
    </ul>
  ),
  ol: ({ className, children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className={cn("mb-3 list-decimal pl-5 leading-relaxed last:mb-0", className)} {...props}>
      {children}
    </ol>
  ),
  li: ({ className, children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className={cn("mb-1 last:mb-0", className)} {...props}>
      {children}
    </li>
  ),

  /* ---- Task list items ---- */
  input: ({ checked }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <span className="text-muted-foreground/60 mr-2">{checked ? "☑" : "☐"}</span>
  ),

  /* ---- Line breaks ---- */
  br: () => <br />,
};
