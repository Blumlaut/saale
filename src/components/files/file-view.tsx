"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { mimeTypeForName, previewKindFor } from "@/lib/files/mime";
import { rawFileUrl } from "@/lib/files/urls";
import { languageFromPath, previewKindFromPath, type PreviewKind } from "@/lib/editor/editor-utils";
import { FilePreview } from "./file-preview";
import type { FileEntry } from "@/lib/files/types";

// Monaco touches window at module scope; keep it out of the SSR bundle.
const MonacoView = dynamic(
  () => import("@/components/editor/monaco-view").then((m) => m.MonacoView),
  { ssr: false },
);

type View = "code" | "preview";

/**
 * One file's bytes, rendered.
 *
 * Text files open in Monaco, markdown and HTML gain a rendered preview, images
 * and video play inline, and anything else says it cannot be shown. The bytes
 * arrive through the raw endpoint, which serves executable types as plain text,
 * so an agent-written HTML file is safe to show here.
 *
 * The chrome belongs to the host: a sheet in the files page, a tab in the coder
 * panel.
 */
export function FileView({ target, entry }: { target: string; entry: FileEntry }) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const [view, setView] = useState<View>("code");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [binaryDetected, setBinaryDetected] = useState(false);

  const mimeKind = previewKindFor(entry.name, mimeTypeForName(entry.name));
  const previewKind = previewKindFromPath(entry.path);
  const hasCode = mimeKind === "text";
  const hasPreview = previewKind !== null;
  const tooLarge = entry.size > MAX_PREVIEW_BYTES;
  const filePath = entry.path;

  // A new file: reset state and pick the opening view. Media has no code
  // view; text opens in code even when it can also render. Deps are the file
  // identity, not the entry object, or a list refresh would reset the view.
  useEffect(() => {
    setView(hasCode ? "code" : hasPreview ? "preview" : "code");
    setText(null);
    setError("");
    setBinaryDetected(false);
  }, [target, filePath, hasCode, hasPreview]);

  useEffect(() => {
    if (!hasCode || tooLarge || view !== "code") return;
    if (text !== null) return;

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
        const body = await response.text();
        // The extension says text, the bytes disagree: a NUL anywhere in the
        // first megabyte is not prose.
        if (body.slice(0, 1024 * 1024).includes("\u0000")) {
          setBinaryDetected(true);
          return;
        }
        setText(body);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("[file-view] failed to read file:", err);
        setError(err instanceof Error ? err.message : "Could not open this file.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [target, filePath, hasCode, tooLarge, view, text]);

  const needsText = view === "code" || previewKind === "markdown" || previewKind === "html";
  const showSpinner = needsText && !error && text === null && loading;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {hasCode && hasPreview ? (
        <Tabs
          value={view}
          onValueChange={(next) => setView(next as View)}
          className="shrink-0 self-start"
        >
          <TabsList className="h-7">
            <TabsTrigger value="code" className="text-xs">
              Code
            </TabsTrigger>
            <TabsTrigger value="preview" className="text-xs">
              Preview
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

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
            content={text ?? undefined}
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
              content={text ?? ""}
              language={languageFromPath(filePath)}
              theme={theme}
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
