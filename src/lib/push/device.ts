/**
 * What a subscription runs on.
 *
 * Web Push says nothing about the device behind an endpoint: a push service
 * hands a payload to whatever browser asked for it. The browser is what knows,
 * so it says so when it subscribes, and the user agent is the fallback for a
 * row that predates the question.
 */

/** Where a subscribed browser runs. Only a computer can pre-empt a phone. */
export type PushDeviceKind = "desktop" | "mobile";

/**
 * A phone or tablet in a user agent. Tablets do not always carry `Mobile`
 * (an iPad reports "Macintosh"), so the device names stand on their own.
 */
const MOBILE_USER_AGENT = /Mobi|Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i;

export function isPushDeviceKind(value: unknown): value is PushDeviceKind {
  return value === "desktop" || value === "mobile";
}

/** Best guess for a browser that did not say which one it is. */
export function deviceKindFromUserAgent(userAgent: string | null | undefined): PushDeviceKind {
  return userAgent && MOBILE_USER_AGENT.test(userAgent) ? "mobile" : "desktop";
}
