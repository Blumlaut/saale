"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, FileText, TerminalSquare } from "lucide-react";
import { Page, PageTabStrip } from "@/components/layout/page";
import { PanelResizeHandle } from "@/components/layout/panel-resize-handle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectMenu, type ConnectedMachine } from "@/components/files/connect-menu";
import { FileBrowser } from "@/components/files/file-browser";
import { CloseTab, DirtyDot, FileTabContent } from "@/components/session/file-tab";
import { useFileTabs, type OpenFile } from "@/components/files/use-file-tabs";
import { useResizableWidth, panelCeiling } from "@/hooks/use-resizable-width";
import { useElementWidth } from "@/hooks/use-element-width";
import { machineFileTarget, USER_FILE_TARGET } from "@/lib/files/target-tokens";
import { fetchJson } from "@/lib/http";
import type { FileEntry } from "@/lib/files/types";
import { cn } from "@/lib/utils";

/** The browser's width, remembered per browser. */
const BROWSER_PANEL = {
  storageKey: "saale.files.browserWidth",
  label: "Resize the file browser",
  defaultWidth: 320,
  minWidth: 240,
  maxWidth: 560,
  handle: "right",
} as const;

/** The room the editor keeps beside the browser. */
const EDITOR_MIN_WIDTH = 480;

/** The strip's pinned console tab. */
const CONSOLE_TAB = "console";

/** xterm is a large library, and the page is often read without a terminal. */
const ConsolePanel = dynamic(
  () => import("@/components/console/console-panel").then((m) => m.ConsolePanel),
  { ssr: false },
);

/**
 * Files, as a workspace: the browser on one side and the editor on the other.
 *
 * The same components the coder panel uses, laid out for a whole page, so a
 * file opens wide. Files open as tabs, each one
 * keeping its buffer while another is in front. A phone gets one of the two
 * panes at a time: opening a file swaps the browser for the editor, and the
 * back arrow swaps them back.
 */
export default function FilesPage() {
  const [machine, setMachine] = useState<ConnectedMachine | null>(null);
  const target = useMemo(
    () => (machine ? machineFileTarget(machine.id) : USER_FILE_TARGET),
    [machine],
  );

  const tabs = useFileTabs();
  // The file a close would lose unsaved text from, while it is being asked about.
  const [closing, setClosing] = useState<OpenFile | null>(null);
  // A phone shows one pane; opening a file or a tab brings the editor forward.
  const [editorOpen, setEditorOpen] = useState(false);
  // The console tab exists while it is open, and is in front while it is not
  // behind a file: a terminal kept mounted there holds its screen.
  const [consoleTab, setConsoleTab] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // A deployment without the sandbox service, or a machine that is not there,
  // has no shell to offer. Unknown until the server answers.
  const [consoleReady, setConsoleReady] = useState<boolean | null>(null);

  const [measureRow, rowWidth] = useElementWidth();
  const panel = useResizableWidth({
    ...BROWSER_PANEL,
    maxWidth: panelCeiling(rowWidth, EDITOR_MIN_WIDTH, BROWSER_PANEL),
  });

  const showEditor = () => {
    setEditorOpen(true);
  };

  const openFile = (target: string, entry: FileEntry) => {
    tabs.open(target, entry);
    setConsoleOpen(false);
    showEditor();
  };

  // Nothing open means no editor: the space belongs to the browser, which is
  // the only thing there is to read.
  const editorVisible = consoleTab || tabs.files.length > 0;
  const activeView = consoleOpen ? CONSOLE_TAB : (tabs.activeId ?? CONSOLE_TAB);

  useEffect(() => {
    let cancelled = false;
    setConsoleReady(null);

    void fetchJson<{ available: boolean }>(`/api/terminal?target=${encodeURIComponent(target)}`)
      .then((answer) => {
        if (cancelled) return;
        setConsoleReady(answer.available);
        if (!answer.available) {
          setConsoleOpen(false);
          setConsoleTab(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to check whether this workspace has a terminal:", err);
        setConsoleReady(false);
        setConsoleOpen(false);
        setConsoleTab(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  const openConsole = () => {
    setConsoleTab(true);
    setConsoleOpen(true);
    showEditor();
  };

  const closeTab = (id: string) => {
    if (tabs.dirty.has(id)) {
      setClosing(tabs.files.find((file) => file.id === id) ?? null);
      return;
    }
    closeFile(id);
  };

  /** Drop a tab, and the phone's editor with the last of them. */
  const closeFile = (id: string) => {
    tabs.close(id);
    if (tabs.files.length === 1 && !consoleTab) setEditorOpen(false);
  };

  /** Put the console away. Its shell keeps running on the server. */
  const closeConsole = () => {
    setConsoleTab(false);
    setConsoleOpen(false);
    if (tabs.files.length === 0) setEditorOpen(false);
  };

  /** Another workspace is another set of files, so nothing stays open. */
  const connect = (next: ConnectedMachine | null) => {
    setMachine(next);
    tabs.clear();
    setConsoleOpen(false);
    setConsoleTab(false);
    setEditorOpen(false);
  };

  return (
    <Page className="gap-0">
      <div ref={measureRow} className="flex min-h-0 flex-1 overflow-hidden md:gap-4">
        <div
          className={cn(
            "min-h-0",
            editorVisible ? "flex-1 md:flex-none" : "flex-1",
            editorVisible && editorOpen && "hidden md:block",
          )}
          style={editorVisible ? { width: panel.width } : undefined}
        >
          <FileBrowser
            key={target}
            target={target}
            onOpenFile={(entry) => openFile(target, entry)}
            actions={
              <>
                {/* The way into the pane when nothing is open, and a phone's
                    only one. */}
                {consoleReady === true ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open the console"
                    onClick={openConsole}
                  >
                    <TerminalSquare className="h-4 w-4" />
                  </Button>
                ) : null}
                <ConnectMenu
                  machine={machine}
                  onConnect={connect}
                  onDisconnect={() => connect(null)}
                />
              </>
            }
            emptyHint={
              machine
                ? `Files in ${machine.name}'s home directory.`
                : "Files an agent writes and files you upload land here."
            }
          />
        </div>

        {/* Drag to widen the browser; arrow keys do the same from the keyboard. */}
        {editorVisible ? (
          <PanelResizeHandle
            handle={panel.handleProps}
            dragging={panel.dragging}
            className="hidden md:flex"
          />
        ) : null}

        {editorVisible ? (
          <div className={cn("min-h-0 min-w-0 flex-1", !editorOpen && "hidden md:flex")}>
            <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
              <Tabs
                value={activeView}
                onValueChange={(id) => {
                  if (id === CONSOLE_TAB) {
                    openConsole();
                    return;
                  }
                  setConsoleOpen(false);
                  tabs.activate(id);
                  showEditor();
                }}
                className="flex min-h-0 flex-1 flex-col gap-0"
              >
                <div className="flex shrink-0 items-center gap-1 border-b">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back to files"
                    className="ml-1 h-6 w-6 shrink-0 md:hidden"
                    onClick={() => setEditorOpen(false)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <PageTabStrip className="min-w-0 flex-1 px-2 py-1.5">
                    <TabsList>
                      {tabs.files.map((file) => (
                        <TabsTrigger
                          key={file.id}
                          value={file.id}
                          aria-label={file.entry.name}
                          className="max-w-48 gap-1.5 text-xs"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{file.entry.name}</span>
                          {tabs.dirty.has(file.id) ? <DirtyDot /> : null}
                          <CloseTab
                            label={`Close ${file.entry.name}`}
                            onClose={() => closeTab(file.id)}
                          />
                        </TabsTrigger>
                      ))}
                      {consoleTab ? (
                        <TabsTrigger value={CONSOLE_TAB} className="gap-1.5 text-xs">
                          <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
                          Console
                          <CloseTab label="Close the console" onClose={closeConsole} />
                        </TabsTrigger>
                      ) : null}
                    </TabsList>
                  </PageTabStrip>
                </div>

                {tabs.files.map((file) => (
                  <TabsContent
                    key={file.id}
                    value={file.id}
                    keepMounted
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                  >
                    <FileTabContent
                      target={file.target}
                      entry={file.entry}
                      onDirtyChange={(dirty) => tabs.setDirty(file.id, dirty)}
                    />
                  </TabsContent>
                ))}

                {consoleTab ? (
                  <TabsContent
                    value={CONSOLE_TAB}
                    keepMounted
                    className="flex min-h-0 flex-1 flex-col overflow-hidden p-2"
                  >
                    <ConsolePanel target={target} />
                  </TabsContent>
                ) : null}
              </Tabs>
            </GlassPanel>
          </div>
        ) : null}
      </div>

      {/* Closing a tab is a file's buffer going away, so it is asked about. */}
      <AlertDialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-all">
              Discard the changes to “{closing?.entry.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The edits in this tab were never saved, and closing it loses them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (closing) closeFile(closing.id);
                setClosing(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
