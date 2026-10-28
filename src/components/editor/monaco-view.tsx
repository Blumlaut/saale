"use client";

/**
 * A Monaco text view over content the caller fetched. The host boots
 * asynchronously, so an overlay covers the container until Monaco paints.
 *
 * The component is keyed per file by its parent; content and language updates
 * for the same file sync the model in place, keeping cursor and scroll.
 */

import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { Loader2 } from "lucide-react";
import { initMonaco } from "@/lib/editor/monaco";

const MONACO_FONT = "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export interface MonacoViewProps {
  content: string;
  /** Monaco language id; "" renders as plaintext. */
  language: string;
  theme: "light" | "dark";
  fontSize?: number;
  readOnly?: boolean;
  onContentChange?: (content: string) => void;
  /** Bound to Cmd/Ctrl+S inside the editor. */
  onSave?: () => void;
}

export function MonacoView({
  content,
  language,
  theme,
  fontSize = 12,
  readOnly = true,
  onContentChange,
  onSave,
}: MonacoViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const [ready, setReady] = useState(false);

  // Latest props — the mount effect closes over the first render's values, so
  // the model starts from whatever the caller has by the time the host boots.
  const contentRef = useRef(content);
  const languageRef = useRef(language);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    contentRef.current = content;
    languageRef.current = language;
    onContentChangeRef.current = onContentChange;
    onSaveRef.current = onSave;
  }, [content, language, onContentChange, onSave]);

  useEffect(() => {
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;

    void (async () => {
      try {
        const m = await initMonaco();
        if (disposed || !containerRef.current) return;

        model = m.editor.createModel(contentRef.current, languageRef.current || "plaintext");
        if (disposed) {
          model.dispose();
          return;
        }
        modelRef.current = model;

        editor = m.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          fontFamily: MONACO_FONT,
          fontSize,
          readOnly,
          tabSize: 2,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "off",
          renderLineHighlight: "line",
          padding: { top: 8 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        if (!readOnly) {
          editor.onDidChangeModelContent(() => {
            if (model && !model.isDisposed()) onContentChangeRef.current?.(model.getValue());
          });
          // The browser's own Ctrl+S would otherwise offer to save the page.
          editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSaveRef.current?.());
        }
        editorRef.current = editor;
        setReady(true);
      } catch (err) {
        console.error("[monaco] failed to mount editor:", err);
        setReady(true);
      }
    })();

    return () => {
      disposed = true;
      editorRef.current = null;
      modelRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // A file the caller re-read: sync the model in place so the view refreshes
  // without losing cursor and scroll. No-op on mount.
  useEffect(() => {
    const model = modelRef.current;
    const editor = editorRef.current;
    if (!model || model.isDisposed() || model.getValue() === content) return;
    const scrollTop = editor?.getScrollTop() ?? 0;
    model.setValue(content);
    editor?.setScrollTop(scrollTop);
  }, [content]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.isDisposed() || model.getLanguageId() === (language || "plaintext")) return;
    const m = initMonaco().then((ns) => ns.editor.setModelLanguage(model, language || "plaintext"));
    void m;
  }, [language]);

  useEffect(() => {
    void initMonaco().then((m) => m.editor.setTheme(theme === "dark" ? "vs-dark" : "vs"));
  }, [theme]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {!ready && (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Opening…
        </div>
      )}
    </div>
  );
}
