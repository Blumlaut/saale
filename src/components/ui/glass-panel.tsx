import * as React from "react";
import { cn } from "@/lib/utils";

function GlassPanel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("glass-panel liquid-glass", className)} {...props}>
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
        "border-border/50 flex items-center justify-between border-b px-4 py-3",
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
    <div className={cn("px-4 py-3", className)} {...props}>
      {children}
    </div>
  );
}

function GlassPanelFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "border-border/50 bg-muted/50 flex items-center justify-between border-t px-4 py-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { GlassPanel, GlassPanelHeader, GlassPanelContent, GlassPanelFooter };
