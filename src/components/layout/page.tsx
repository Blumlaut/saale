import * as React from "react";
import { cn } from "@/lib/utils";
import { GlassPanel } from "@/components/ui/glass-panel";

/**
 * Page — root wrapper for every dashboard/admin page.
 *
 * Enforces the app-shell flex containment chain so pages are mobile-safe by
 * construction:
 *
 *   <Page>              flex h-full min-h-0 flex-col gap-4
 *     <PageHeader />    shrink-0  (pinned, never scrolls away)
 *     <PageScroll />    min-h-0 flex-1 overflow-y-auto  (the ONLY scroll region)
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
 * PageHeader — pinned page header. Stays visible while <PageScroll> content
 * scrolls. Pass actions (buttons) so interactive elements never scroll away.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  className,
  ...props
}: React.ComponentProps<"header"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header
      className={cn("flex shrink-0 items-center justify-between gap-3", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon && <GlassPanel className="rounded-xl p-2">{icon}</GlassPanel>}
        <div className="min-w-0">
          <h1 className="truncate text-lg leading-tight font-semibold tracking-tight md:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="text-muted-foreground mt-1 truncate text-xs md:text-sm">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
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
