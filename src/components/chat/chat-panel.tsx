"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, FolderTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileBrowser } from "@/components/files/file-browser";
import {
  SessionPanel,
  SessionPanelSheet,
  type SessionPanelTab,
} from "@/components/session/session-panel";
import { useFileTab } from "@/components/session/file-tab";
import { SessionStatusTab } from "@/components/session/status-tab";
import { fetchJson, type FetchError } from "@/lib/http";
import type { FileEntry } from "@/lib/files/types";
import type { ShownFile } from "@/lib/chat/shown-file";
import type { Message } from "./types";
import { AutomationsJobsLink, SessionLinksContent, type SessionLink } from "./session-links-panel";

/** What `GET /api/chat/workspace-files?stat=1` answers: one file, and the root it sits in. */
export interface StatResponse {
  entry: FileEntry;
  root: string;
}

/**
 * The regular chat's panel: what the chat is, what it holds and what fires into
 * it, plus the workspace it reads and writes.
 *
 * The shell and the file tab are shared with the coder chat (`SessionPanel`),
 * so a tab, a strip and a close control read the same in both. What differs is
 * the content: a coder chat's panel is about a checkout, and this one is about
 * the conversation and its workspace.
 */
export function ChatPanel({
  sessionId,
  tab,
  onTabChange,
  links,
  sharedFile,
  messages,
  collapsed = false,
  onExpand,
  onCollapse,
}: {
  sessionId: string;
  /** The tab shown, and the one the rail puts back. */
  tab: string;
  onTabChange: (id: string) => void;
  links: SessionLink[] | null;
  /** The file the chat last shared: it opens as a tab as it is shared. */
  sharedFile: ShownFile | null;
  /** The transcript as the chat has it, for what its turns cost. */
  messages: readonly Message[];
  /** The panel is put away: only its rail of tabs shows. */
  collapsed?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const files = useFileTab({
    target: "user",
    onClose: () => {
      if (tab === "file") onTabChange("files");
    },
  });
  // The path an agent names is relative to the chat, not to the volume, so the
  // row comes from the server: the same resolution `show_file` uses.
  const [error, setError] = useState("");
  // Only the newest open may write state: a share picked while another is still
  // loading must not be replaced by the slower answer.
  const sequence = useRef(0);
  // A second share of the same file is a new show, so this follows the call
  // rather than the path.
  const openedShare = useRef<string | null>(null);

  const reveal = useCallback(
    async (file: ShownFile) => {
      const id = sequence.current + 1;
      sequence.current = id;
      setError("");
      try {
        const params = new URLSearchParams({ stat: "1", file: file.path, session: sessionId });
        const data = await fetchJson<StatResponse>(`/api/chat/workspace-files?${params}`);
        if (sequence.current !== id) return;
        files.open(data.entry, data.root);
        onTabChange("file");
      } catch (err) {
        console.error(`Failed to open the workspace file "${file.path}":`, err);
        if (sequence.current !== id) return;
        const status = (err as FetchError).status;
        setError(
          status === 404
            ? "That file is not in the workspace any more."
            : err instanceof Error
              ? err.message
              : "Could not open the file",
        );
        onTabChange("files");
      }
    },
    [files, onTabChange, sessionId],
  );

  useEffect(() => {
    if (!sharedFile || openedShare.current === sharedFile.id) return;
    openedShare.current = sharedFile.id;
    void reveal(sharedFile);
  }, [sharedFile, reveal]);

  const tabs: SessionPanelTab[] = [
    {
      id: "status",
      label: "Status",
      icon: <Activity className="h-3.5 w-3.5" />,
      content: (
        <SessionStatusTab
          turns={messages.map((message) => message.stats)}
          automations={<SessionLinksContent links={links} />}
          automationsAction={<AutomationsJobsLink />}
        />
      ),
    },
    {
      id: "files",
      label: "Files",
      icon: <FolderTree className="h-3.5 w-3.5" />,
      content: (
        <div className="flex min-h-0 flex-1 flex-col">
          {error ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-destructive text-xs break-words">{error}</p>
              <Button variant="secondary" size="sm" onClick={() => setError("")}>
                Browse files
              </Button>
            </div>
          ) : (
            <FileBrowser
              target="user"
              dense
              emptyHint="Files an agent writes and files you upload land here."
              onOpenFile={(entry) => {
                files.open(entry);
                onTabChange("file");
              }}
            />
          )}
        </div>
      ),
    },
    ...(files.tab ? [files.tab] : []),
  ];

  return (
    <SessionPanel
      value={tab}
      onValueChange={onTabChange}
      tabs={tabs}
      collapsed={collapsed}
      {...(onExpand ? { onExpand } : {})}
      {...(onCollapse ? { onCollapse } : {})}
    />
  );
}

/** The panel as a phone sees it: a sheet over the conversation. */
export function ChatPanelSheet({
  open,
  onOpenChange,
  ...panel
}: React.ComponentProps<typeof ChatPanel> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <SessionPanelSheet open={open} onOpenChange={onOpenChange} title="Session panel">
      <ChatPanel {...panel} />
    </SessionPanelSheet>
  );
}
