"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Markdown Renderer — liquid glass styling for every element        */
/* ------------------------------------------------------------------ */

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn("markdown-body text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true, placeholderLanguage: "text" }],
        ]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
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
  pre: (props: React.ComponentProps<"pre">) => {
    const { className, children, ...rest } = props;
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-xl bg-[#1e1e2e] p-4 font-mono text-xs leading-relaxed text-gray-200",
          className,
        )}
        {...rest}
      >
        {children}
      </pre>
    );
  },

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
    <div className="border-border/40 bg-muted my-4 overflow-x-auto rounded-xl border dark:bg-white/[0.02]">
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
