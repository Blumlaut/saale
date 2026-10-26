import * as React from "react";
import { AlertCircle, CheckCircle, Loader2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Page. root wrapper for every dashboard/admin page.
 *
 * Enforces the app-shell flex containment chain so pages are mobile-safe by
 * construction:
 *
 *   <Page>              flex h-full min-h-0 flex-col gap-4
 *     <PageActions />   shrink-0  (the first row of the page's panel)
 *     <PageScroll />    min-h-0 flex-1 overflow-y-auto  (the ONLY scroll region)
 *
 * Pages have NO title anywhere. the nav already names the page. A page starts
 * straight at its panel, whose first row is <PageActions>; see the layout rules
 * in AGENTS.md.
 *
 * The shell is `h-dvh overflow-hidden`. the body never scrolls. Content
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
 * PageActions. the top row of the page's panel: functional context on the left,
 * the page's actions on the right. One height and one button size everywhere, so
 * no page has to pick its own.
 */
export function PageActions({
  leading,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { leading?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "border-border/30 flex min-h-14 shrink-0 items-center gap-2 border-b px-4 py-2",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{leading}</div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * PageAction. the page's button. an `h-8` primary button carrying the icon, with
 * its label waiting for `md`, so the row holds its height on a phone.
 */
export function PageAction({
  icon: Icon,
  label,
  busy,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children" | "size"> & {
  icon?: LucideIcon;
  label: string;
  /** Swaps the icon for a spinner and disables the button. */
  busy?: boolean;
}) {
  return (
    <Button
      size="icon"
      className={cn("h-8 w-8 md:w-auto md:gap-1.5 md:px-3", className)}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

/** Save or failure feedback, left of the row's actions. */
export function PageStatus({
  status,
  savedLabel = "Saved",
  failedLabel = "Failed",
}: {
  status: "idle" | "success" | "error";
  savedLabel?: string;
  failedLabel?: string;
}) {
  if (status === "idle") return null;

  const saved = status === "success";
  const Icon = saved ? CheckCircle : AlertCircle;
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs",
        saved ? "text-muted-foreground" : "text-destructive",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {saved ? savedLabel : failedLabel}
    </span>
  );
}

/**
 * A titled block inside the page's panel. Sections stack, divided, so a page
 * keeps one card no matter how many groups of settings it holds.
 */
export function PageSection({
  title,
  action,
  className,
  children,
  ...props
}: React.ComponentProps<"section"> & { title: string; action?: React.ReactNode }) {
  return (
    <section className={cn("border-border/50 border-b last:border-b-0", className)} {...props}>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-base leading-snug font-semibold md:text-lg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * PageScroll. the single scrollable content region of a page.
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
 * PageTabStrip. pinned, horizontally swipe-scrollable tab strip.
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
