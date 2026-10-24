/**
 * monaco-editor ships types for its public API only; the diff editor's
 * overview-ruler feature is a deep import we patch for the diff gutter's
 * width, so we declare the two constants we read from it here.
 */
declare module "monaco-editor/editor/browser/widget/diffEditor/features/overviewRulerFeature.js" {
  export const OverviewRulerFeature: {
    ONE_OVERVIEW_WIDTH: number;
    ENTIRE_DIFF_OVERVIEW_WIDTH: number;
  };
}
