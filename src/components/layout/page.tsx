import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Page — root wrapper for every dashboard/admin page.
 *
 * Enforces the app-shell flex containment chain so pages are mobile-safe by
 * construction:
 *
 *   <Page>              flex h-full min-h-0 flex-col gap-4
 *     <PageToolbar />   shrink-0  (optional pinned action row, never scrolls away)
 *     <PageScroll />    min-h-0 flex-1 overflow-y-auto  (the ONLY scroll region)
 *
 * Pages have NO title/subtitle header — the nav already names the page, so
 * the header row was pure waste. If the page has actions that must stay
 * visible, pin them in <PageToolbar>; otherwise start straight at the content.
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
 * PageToolbar — compact one-line page header: title left, actions right.
 * No subtitle — the nav already explains what the page is for. Stays visible
 * while <PageScroll> content scrolls; holds the buttons that must not scroll
 * away ("New X", Save, status chips).
 */
export function PageToolbar({
  title,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { title: string }) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-between gap-2 px-2 md:px-0", className)}
      {...props}
    >
      <h1 className="text-muted-foreground min-w-0 truncate text-sm font-semibold md:text-base">
        {title}
      </h1>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">{children}</div>
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
