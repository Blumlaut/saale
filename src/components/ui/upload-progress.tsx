import { cn, formatFileSize } from "@/lib/utils";
import type { UploadProgress } from "@/lib/files/upload-client";

/**
 * One file on its way into a workspace: how much of it has arrived.
 *
 * Shared by the file browser and the chat composer so a large upload reads the
 * same in both places. Byte counts rather than a bare percentage, because a
 * snapshot crawling in at 40% of 2 GB is a different wait from 40% of a photo.
 */
export function UploadProgressBar({
  progress,
  className,
}: {
  progress: UploadProgress;
  className?: string;
}) {
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-mono">{progress.name}</span>
        {progress.count > 1 && (
          <span className="console-label shrink-0">
            {progress.index} of {progress.count}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
          {formatFileSize(progress.sent)} / {formatFileSize(progress.total)}
        </span>
        <span className="text-muted-foreground w-9 shrink-0 text-right tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-150 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
