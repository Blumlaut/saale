"use client";

import { GitFork, Trash2, MoreVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGitHubIntegration } from "@/hooks/use-github-integration";

/**
 * GitHub integration card.
 *
 * Self-contained: uses useGitHubIntegration for all data/actions.
 * Delegates delete to the parent via `onDelete`.
 */
export function GitHubCard({ onDelete }: { onDelete: () => void }) {
  const { account, actionLoading, toggleEnabled } = useGitHubIntegration();

  if (!account) return null;

  return (
    <div className="liquid-glass-inner rounded-2xl border-0 p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-gray-500/10 p-2.5">
            <GitFork className="h-5 w-5 text-gray-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">GitHub</h4>
              {account.username && (
                <Badge variant="secondary" className="rounded-full">
                  {account.username}
                </Badge>
              )}
              {!account.enabled && (
                <Badge variant="outline" className="rounded-full">
                  Disabled
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Agents can use <code className="bg-muted/50 rounded px-1 text-[10px]">gh</code> CLI to
              manage repos, PRs, and issues
              {account.enabled ? " · Active" : " · Disabled"}
            </p>
            <p className="text-muted-foreground text-xs">
              Added {new Date(account.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Enable</span>
            <Switch
              checked={account.enabled}
              onCheckedChange={toggleEnabled}
              disabled={actionLoading === "toggle"}
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!!actionLoading}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove Integration
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
