"use client";

/**
 * A Monaco diff view over two contents the caller fetched (a commit's parent
 * and the commit itself). Models are transient, on a private scheme, so they
 * never collide with the editor's file models.
 *
 * Side-by-side only earns its room in a wide panel, so the render mode
 * follows the container width instead of switching on a fixed 900px cutoff
 * Monaco would apply on its own.
 */

import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { Loader2 } from "lucide-react";
import { initMonaco } from "@/lib/editor/monaco";

const MONACO_FONT = "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Below this width the two columns would each be narrower than one tab stop. */
const SIDE_BY_SIDE_MIN_WIDTH = 560;

export interface MonacoDiffViewProps {
  /** File path, used for language detection and the model ids. */
  path: string;
  original: string;
  modified: string;
  /** Monaco language id; "" renders as plaintext. */
  language: string;
  theme: "light" | "dark";
  fontSize?: number;
}

export function MonacoDiffView({
  path,
  original,
  modified,
  language,
  theme,
  fontSize = 12,
}: MonacoDiffViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const [ready, setReady] = useState(false);
  const [sideBySide, setSideBySide] = useState(true);

  // Latest props — the mount effect closes over the first render's values, so
  // the models start from whatever the caller has by the time the host boots.
  const originalRef = useRef(original);
  const modifiedRef = useRef(modified);

  useEffect(() => {
    originalRef.current = original;
    modifiedRef.current = modified;
  }, [original, modified]);

  // The container may start hidden (a tab the user is about to open) or grow
  // with the panel's drag handle, so measure instead of trusting one read.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = (width: number) => {
      const next = width >= SIDE_BY_SIDE_MIN_WIDTH;
      setSideBySide((current) => (current === next ? current : next));
    };
    update(container.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let diff: monaco.editor.IStandaloneDiffEditor | null = null;
    let originalModel: monaco.editor.ITextModel | null = null;
    let modifiedModel: monaco.editor.ITextModel | null = null;

    void (async () => {
      try {
        const m = await initMonaco();
        if (disposed || !containerRef.current) return;

        originalModel = m.editor.createModel(
          originalRef.current,
          language || "plaintext",
          m.Uri.parse(`git-diff://original${path}`),
        );
        modifiedModel = m.editor.createModel(
          modifiedRef.current,
          language || "plaintext",
          m.Uri.parse(`git-diff://modified${path}`),
        );
        if (disposed) {
          originalModel.dispose();
          modifiedModel.dispose();
          return;
        }
        originalModelRef.current = originalModel;
        modifiedModelRef.current = modifiedModel;

        diff = m.editor.createDiffEditor(containerRef.current, {
          readOnly: true,
          renderSideBySide: true,
          // The container width decides the mode; without this Monaco
          // silently flips any narrow diff to inline on its own.
          useInlineViewWhenSpaceIsLimited: false,
          automaticLayout: true,
          fontFamily: MONACO_FONT,
          fontSize,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "off",
          renderLineHighlight: "line",
          padding: { top: 8 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        diff.setModel({ original: originalModel, modified: modifiedModel });
        diffRef.current = diff;
        setReady(true);
      } catch (err) {
        console.error("[monaco] failed to mount diff:", err);
        setReady(true);
      }
    })();

    return () => {
      disposed = true;
      diffRef.current = null;
      originalModelRef.current = null;
      modifiedModelRef.current = null;
      diff?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
    // The models are keyed to this component instance, and the parent keys the
    // component per file, so they are built once and synced in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language]);

  // A re-read of the same commit: sync the models in place so the diff
  // recomputes without losing either side's scroll position. No-op on mount.
  useEffect(() => {
    const originalModel = originalModelRef.current;
    const modifiedModel = modifiedModelRef.current;
    const diff = diffRef.current;
    if (!originalModel || !modifiedModel || !diff) return;
    if (originalModel.getValue() !== original) {
      const editor = diff.getOriginalEditor();
      const scrollTop = editor.getScrollTop();
      originalModel.setValue(original);
      editor.setScrollTop(scrollTop);
    }
    if (modifiedModel.getValue() !== modified) {
      const editor = diff.getModifiedEditor();
      const scrollTop = editor.getScrollTop();
      modifiedModel.setValue(modified);
      editor.setScrollTop(scrollTop);
    }
  }, [original, modified]);

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  useEffect(() => {
    void initMonaco().then((m) => m.editor.setTheme(theme === "dark" ? "vs-dark" : "vs"));
  }, [theme]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {!ready && (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Opening diff…
        </div>
      )}
    </div>
  );
}
