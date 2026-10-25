/**
 * Browser side of Web Push. Everything here needs `navigator`, so it only runs
 * from a client component.
 */

/** Whether this browser can subscribe at all. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The browser's notification permission. */
export function getNotificationPermission(): NotificationPermission {
  return typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "denied";
}

/**
 * The VAPID key as bytes. `pushManager.subscribe` takes an ArrayBuffer, while
 * the server hands the key over in base64url.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalised);

  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The subscription this browser already holds, if any. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;

  return registration.pushManager.getSubscription();
}

/**
 * Ask for permission and subscribe this browser to push.
 *
 * Throws on a refused permission and on a subscription the push service
 * rejected, so the caller can tell the user what went wrong.
 */
export async function subscribeToPush(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    // Chrome refuses a subscription that would show a notification without a
    // user-visible payload, which is every notification Saale sends.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
}

/** Drop this browser's subscription. Returns the endpoint that was removed. */
export async function unsubscribeFromPush(): Promise<string | null> {
  const subscription = await getPushSubscription();
  if (!subscription) return null;

  const { endpoint } = subscription;
  // The server row goes too, whatever the browser reports: a subscription it
  // failed to drop is pruned by the push service answering 404/410.
  await subscription.unsubscribe();
  return endpoint;
}

/** The browser's subscription in the shape the API stores. */
export function serializeSubscription(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;

  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}
