import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-muted/50 animate-pulse rounded-xl", className)} {...props} />;
}

export { Skeleton };
