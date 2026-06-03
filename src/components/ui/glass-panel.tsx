import * as React from "react";
import { cn } from "@/lib/utils";

function GlassPanel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("glass-panel", className)} {...props}>
      {children}
    </div>
  );
}

function GlassPanelHeader({
  className,
  title,
  action,
  children,
  ...props
}: React.ComponentProps<"div"> & { title?: string; action?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "border-border/50 flex items-center justify-between border-b px-4 py-3 md:px-6 md:py-4",
        className,
      )}
      {...props}
    >
      <h2 className="text-base leading-snug font-semibold md:text-lg">{title || children}</h2>
      {action && <div>{action}</div>}
    </div>
  );
}

function GlassPanelContent({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("px-4 py-3 md:px-6 md:py-4", className)} {...props}>
      {children}
    </div>
  );
}

function GlassPanelFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "border-border/50 flex items-center justify-between border-t bg-white/30 px-4 py-3 md:px-6 dark:bg-white/5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { GlassPanel, GlassPanelHeader, GlassPanelContent, GlassPanelFooter };
