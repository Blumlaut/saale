/** Cron expressions the job lists and dialogs name in plain words. */
export const CRON_EXAMPLES: Record<string, string> = {
  "* * * * *": "Every minute",
  "*/5 * * * *": "Every 5 minutes",
  "*/10 * * * *": "Every 10 minutes",
  "*/30 * * * *": "Every 30 minutes",
  "0 * * * *": "Every hour",
  "0 */6 * * *": "Every 6 hours",
  "0 9 * * *": "Daily at 9am",
  "0 9 * * 1": "Monday at 9am",
};

/** An expression as words when it is one of the examples, as written otherwise. */
export function getCronLabel(expression: string): string {
  return CRON_EXAMPLES[expression] ?? expression;
}
