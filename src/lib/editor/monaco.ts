/**
 * One-time browser bootstrap of Monaco: the editor worker and a narrower
 * diff overview strip. Monaco references `window` at module scope, so it is
 * always imported dynamically here, never at the top of a component.
 *
 * ammit ran the vscode-api stack on top of Monaco because it speaks to
 * language servers; the panel reads files and diffs through the API and needs
 * none of that. Plain monaco-editor gives the same highlighting and diff
 * editor without the extension host.
 */

type MonacoNamespace = typeof import("monaco-editor");

/** Diff overview strip per side, in px. Monaco's default is 2 × 15px. */
const DIFF_OVERVIEW_WIDTH = 7;

/**
 * Monaco's diff editor reserves a strip at its right edge for the two diff
 * overview rulers. The width is a private static no editor option exposes, so
 * patch it before the first diff editor is created. The deep import has no
 * type declarations, and if a future Monaco drops or freezes the statics the
 * patch no-ops and the strip is simply wider, never broken.
 */
async function installDiffOverviewWidth(): Promise<void> {
  try {
    const { OverviewRulerFeature } =
      await import("monaco-editor/editor/browser/widget/diffEditor/features/overviewRulerFeature.js");
    Object.assign(OverviewRulerFeature, {
      ONE_OVERVIEW_WIDTH: DIFF_OVERVIEW_WIDTH,
      ENTIRE_DIFF_OVERVIEW_WIDTH: DIFF_OVERVIEW_WIDTH * 2,
    });
  } catch (err) {
    console.warn("[monaco] diff overview width override failed:", err);
  }
}

let monacoPromise: Promise<MonacoNamespace> | null = null;

/** Boot Monaco once; resolves to the shared namespace. */
export function initMonaco(): Promise<MonacoNamespace> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      // The editor worker runs tokenization off the main thread; the
      // language workers answer folding, hints and validation for json, css,
      // html and typescript. Without the language workers those requests
      // reject uncaught in the page.
      (self as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
        getWorker: (_id: string, label: string) => {
          if (label === "json")
            return new Worker(
              new URL("monaco-editor/language/json/json.worker.js", import.meta.url),
              { type: "module" },
            );
          if (label === "css" || label === "scss" || label === "less")
            return new Worker(
              new URL("monaco-editor/language/css/css.worker.js", import.meta.url),
              { type: "module" },
            );
          if (label === "html" || label === "handlebars" || label === "razor")
            return new Worker(
              new URL("monaco-editor/language/html/html.worker.js", import.meta.url),
              { type: "module" },
            );
          if (label === "typescript" || label === "javascript")
            return new Worker(
              new URL("monaco-editor/language/typescript/ts.worker.js", import.meta.url),
              { type: "module" },
            );
          return new Worker(new URL("monaco-editor/editor/editor.worker.js", import.meta.url), {
            type: "module",
          });
        },
      };
      await installDiffOverviewWidth();
      return import("monaco-editor");
    })();
  }
  return monacoPromise;
}
