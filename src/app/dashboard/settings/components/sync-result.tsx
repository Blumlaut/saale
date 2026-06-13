"use client";

interface SyncResultProps {
  itemId: string;
  syncResult: { id: string; created: number; updated: number; deleted: number; parsed: number | null } | null;
  showParsed?: boolean;
  className?: string;
}

export function SyncResult({ itemId, syncResult, showParsed, className = "" }: SyncResultProps) {
  if (!syncResult || syncResult.id !== itemId) return null;

  return (
    <div className={`text-muted-foreground text-xs ${className}`}>
      {showParsed && syncResult.parsed !== null && `(${syncResult.parsed} parsed) · `}
      {syncResult.created > 0 && `${syncResult.created} new · `}
      {syncResult.updated > 0 && `${syncResult.updated} updated · `}
      {syncResult.deleted > 0 && `${syncResult.deleted} removed · `}
      {syncResult.created === 0 &&
        syncResult.updated === 0 &&
        syncResult.deleted === 0 &&
        (showParsed ? (syncResult.parsed ?? 0) === 0 : true) &&
        "No changes"}
    </div>
  );
}
