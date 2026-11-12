"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import type { ImportedMcpServerList } from "@/hooks/use-mcp-servers";

/** What the dialog offers to paste, so the shape is visible before typing. */
const EXAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" }
    }
  }
}`;

/**
 * A server config pasted from another MCP client.
 *
 * The clients all write the same shape, so the dialog takes the text as it was
 * copied and lets the import report what it made of each entry.
 */
export function McpImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (config: string) => Promise<ImportedMcpServerList>;
}) {
  const [config, setConfig] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportedMcpServerList | null>(null);

  const close = (next: boolean) => {
    if (importing) return;
    if (!next) {
      setConfig("");
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  };

  const run = async () => {
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const imported = await onImport(config);
      setResult(imported);
      // Every entry landed: nothing left to read, so close on the way out.
      if (imported.created.length > 0 && imported.skipped.length === 0) {
        setConfig("");
        onOpenChange(false);
      }
    } catch (err) {
      setError((err as Error).message || "Failed to import the config");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import MCP config</DialogTitle>
          <DialogDescription>
            Paste the server list from another MCP client. Each server is added with its command,
            variables and endpoint as written there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            value={config}
            onChange={(event) => {
              setConfig(event.target.value);
              setError(null);
            }}
            placeholder={EXAMPLE}
            spellCheck={false}
            aria-label="MCP config"
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-56 w-full resize-none rounded-lg border px-3 py-2 font-mono text-xs outline-none focus-visible:ring-[3px]"
          />

          {error && (
            <p className="text-destructive flex items-start gap-2 text-xs">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}

          {result && (
            <div className="space-y-2 text-xs">
              {result.created.length > 0 && (
                <p className="flex items-start gap-2 text-green-600 dark:text-green-400">
                  <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    Added {result.created.map((server) => server.name).join(", ")}.
                  </span>
                </p>
              )}
              {result.skipped.map((entry) => (
                <p
                  key={entry.name || entry.error}
                  className="text-destructive flex items-start gap-2"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    {entry.name ? `${entry.name}: ` : ""}
                    {entry.error}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => close(false)}>
            {result && result.created.length > 0 ? "Done" : "Cancel"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={run}
            disabled={importing || !config.trim()}
            aria-label="Import servers"
          >
            {importing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
