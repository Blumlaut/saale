import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Page — root wrapper for every dashboard/admin page.
 *
 * Enforces the app-shell flex containment chain so pages are mobile-safe by
 * construction:
 *
 *   <Page>              flex h-full min-h-0 flex-col gap-4
 *     <PageToolbar />   shrink-0  (form pages only — pinned status + Save row)
 *     <PageScroll />    min-h-0 flex-1 overflow-y-auto  (the ONLY scroll region)
 *
 * Pages have NO title anywhere — the nav already names the page. List/content
 * pages start straight at a single full-height panel whose first row is the
 * toolbar (actions right-aligned); see the layout rules in AGENTS.md.
 *
 * The shell is `h-dvh overflow-hidden` — the body never scrolls. Content
 * taller than the viewport must live inside <PageScroll>. Do NOT use
 * `h-dvh`, `h-screen`, or `calc(100vh - X)` on page components.
 */
export function Page({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-4", className)} {...props}>
      {children}
    </div>
  );
}

/**
 * PageToolbar — pinned slim action row for form pages (status + Save) that
 * have no natural spot in the content. Right-aligned, never titled.
 * List/content pages don't use this — their first panel owns the toolbar row
 * instead (see the layout rules in AGENTS.md).
 */
export function PageToolbar({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-end gap-2 px-2 md:px-0", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * PageScroll — the single scrollable content region of a page.
 * Everything below the header lives here; it scrolls internally.
 */
export function PageScroll({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto", className)} {...props}>
      {children}
    </div>
  );
}

/**
 * PageTabStrip — pinned, horizontally swipe-scrollable tab strip.
 * Use inside a Tabs root between the header and the tab content:
 *
 *   <Tabs className="flex min-h-0 flex-1 flex-col">
 *     <PageTabStrip><TabsList>…</TabsList></PageTabStrip>
 *     <TabsContent className="min-h-0 flex-1 overflow-y-auto">…</TabsContent>
 *   </Tabs>
 *
 * The scrollbar is hidden (`.no-scrollbar`) so it never overlaps the tabs.
 */
export function PageTabStrip({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("no-scrollbar shrink-0 overflow-x-auto", className)} {...props}>
      {children}
    </div>
  );
}
