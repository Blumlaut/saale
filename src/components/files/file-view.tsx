"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { looksBinary, mimeTypeForName, previewKindFor } from "@/lib/files/mime";
import { rawFileUrl } from "@/lib/files/urls";
import { languageFromPath, previewKindFromPath, type PreviewKind } from "@/lib/editor/editor-utils";
import { useFileSave } from "./use-file-save";
import { FilePreview } from "./file-preview";
import type { FileEntry } from "@/lib/files/types";

// Monaco touches window at module scope; keep it out of the SSR bundle.
const MonacoView = dynamic(
  () => import("@/components/editor/monaco-view").then((m) => m.MonacoView),
  { ssr: false },
);

type View = "code" | "preview";

/** A file as it stands on disk: the text, and the mtime it was read at. */
type LoadedFile = { text: string; modified: number };

/**
 * One file's bytes, rendered.
 *
 * Text files open in Monaco, markdown and HTML gain a rendered preview, images
 * and video play inline, and anything else says it cannot be shown. The bytes
 * arrive through the raw endpoint, which serves executable types as plain text,
 * so an agent-written HTML file is safe to show here.
 *
 * A writable text file is editable: Monaco holds the buffer and Save puts it
 * back, with the mtime it was read at so a file an agent rewrote underneath is a
 * conflict rather than a silent overwrite.
 *
 * The chrome belongs to the host: a sheet in the files page, a tab in the coder
 * panel.
 */
export function FileView({
  target,
  entry,
  onDirtyChange,
}: {
  target: string;
  entry: FileEntry;
  /** Told when the editor starts or stops holding unsaved text. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const [view, setView] = useState<View>("code");
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [binaryDetected, setBinaryDetected] = useState(false);

  const mimeKind = previewKindFor(entry.name, mimeTypeForName(entry.name));
  const previewKind = previewKindFromPath(entry.path);
  const hasCode = mimeKind === "text";
  const hasPreview = previewKind !== null;
  const tooLarge = entry.size > MAX_PREVIEW_BYTES;
  // Text only, and only once it has arrived: saving a half-loaded file would
  // overwrite the parts that have not come in yet.
  const editable = hasCode && entry.writable && !tooLarge && file !== null && !binaryDetected;
  const filePath = entry.path;

  const save = useFileSave({
    target,
    path: filePath,
    baseModified: file?.modified ?? null,
    enabled: editable,
    saved: file?.text ?? null,
    onSaved: (text, modified) => setFile({ text, modified }),
  });

  // A new file: reset state and pick the opening view. Media has no code
  // view; text opens in code even when it can also render. Deps are the file
  // identity, not the entry object, or a list refresh would reset the view.
  useEffect(() => {
    setView(hasCode ? "code" : hasPreview ? "preview" : "code");
    setFile(null);
    setError("");
    setBinaryDetected(false);
  }, [target, filePath, hasCode, hasPreview]);

  useEffect(() => {
    onDirtyChange?.(save.dirty);
  }, [save.dirty, onDirtyChange]);

  useEffect(() => {
    if (!hasCode || tooLarge || view !== "code") return;
    if (file !== null) return;

    const controller = new AbortController();
    setLoading(true);
    setError("");

    void (async () => {
      try {
        const response = await fetch(rawFileUrl(target, filePath), { signal: controller.signal });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not open this file (${response.status}).`);
        }
        // The extension says text, so the bytes decide whether it is: a name
        // that lies still gets the refusal rather than a screen of mojibake.
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (looksBinary(bytes)) {
          setBinaryDetected(true);
          return;
        }
        setFile({ text: new TextDecoder().decode(bytes), modified: entry.modified });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("[file-view] failed to read file:", err);
        setError(err instanceof Error ? err.message : "Could not open this file.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [target, filePath, entry.modified, hasCode, tooLarge, view, file]);

  const needsText = view === "code" || previewKind === "markdown" || previewKind === "html";
  const showSpinner = needsText && !error && file === null && loading;
  const toolbar = (hasCode && hasPreview) || (editable && view === "code");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {toolbar ? (
        <div className="flex shrink-0 items-center justify-between gap-2">
          {hasCode && hasPreview ? (
            <Tabs value={view} onValueChange={(next) => setView(next as View)}>
              <TabsList className="h-7">
                <TabsTrigger value="code" className="text-xs">
                  Code
                </TabsTrigger>
                <TabsTrigger value="preview" className="text-xs">
                  Preview
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : (
            <span />
          )}
          {editable && view === "code" ? (
            <div className="flex items-center gap-2">
              {save.dirty ? (
                <span className="text-muted-foreground hidden text-xs sm:inline" aria-live="polite">
                  Unsaved
                </span>
              ) : null}
              <Button
                size="sm"
                variant={save.dirty ? "default" : "secondary"}
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={!save.dirty || save.saving}
                onClick={save.save}
              >
                {save.saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {save.error ? <p className="text-destructive text-xs break-words">{save.error}</p> : null}

      {error ? (
        <p className="text-destructive text-sm break-words">{error}</p>
      ) : tooLarge ? (
        <p className="text-muted-foreground text-sm">
          This file is too large to show here. Download it to read it.
        </p>
      ) : binaryDetected ? (
        <p className="text-muted-foreground text-sm">
          This file cannot be shown here. Download it to open it.
        </p>
      ) : view === "preview" && hasPreview ? (
        showSpinner ? (
          <CenterSpinner />
        ) : (
          <FilePreview
            target={target}
            entry={entry}
            kind={previewKind as PreviewKind}
            content={file?.text ?? undefined}
          />
        )
      ) : view === "code" && hasCode ? (
        // Long lines scroll in this box rather than breaking every token.
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          {showSpinner ? (
            <CenterSpinner />
          ) : (
            <MonacoView
              key={filePath}
              content={file?.text ?? ""}
              language={languageFromPath(filePath)}
              theme={theme}
              readOnly={!editable}
              onContentChange={save.onChange}
              onSave={save.save}
            />
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          This file cannot be shown here. Download it to open it.
        </p>
      )}
    </div>
  );
}

function CenterSpinner() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
    </div>
  );
}
