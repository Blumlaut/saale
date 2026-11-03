/**
 * The windows the usage page offers, in days.
 *
 * Client-safe: the page's picker and the route's validation both read it, and
 * the report's own module pulls in the database.
 */
export const USAGE_WINDOWS = [7, 30, 90] as const;

export type UsageWindow = (typeof USAGE_WINDOWS)[number];
