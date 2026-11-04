/* eslint-disable no-console -- this runs in the worker, where the logs are the operator's view */
import { GrammyError } from "grammy";
import type { TelegramBotConfig } from "./bot";
import { getEnabledTelegramBot } from "./bot";
import { createBot } from "./client";
import { handleTelegramUpdate } from "./updates";

/**
 * Telegram delivery for an instance that cannot receive a webhook.
 *
 * `setWebhook` needs a public HTTPS URL, so an instance on a LAN address or
 * behind NAT has no way to be pushed to. Telegram keeps updates for 24 hours
 * until someone fetches them, and `getUpdates` long polling fetches them
 * without any inbound reachability at all.
 *
 * Both modes cannot run at once: `getUpdates` answers 409 while a webhook is
 * set, and setting a webhook stops the poll. The worker owns the decision,
 * because it is the only process that lives long enough to hold a poll open.
 */

/** How often the worker re-checks which mode the bot is in. */
const DELIVERY_CHECK_INTERVAL_MS = 60_000;

/** Telegram holds the long poll open this long before answering empty-handed. */
const POLL_TIMEOUT_SECONDS = 30;

/** Updates per poll. Telegram caps this at 100. */
const POLL_LIMIT = 100;

/** Telegram's answer to a network blip; the next poll is a second away. */
const POLL_RETRY_DELAY_MS = 5_000;

interface Poller {
  /** The token the loop is running with. A saved token starts a new one. */
  encryptedToken: string;
  controller: AbortController;
}

/** The running loop, or null when updates arrive some other way. */
let poller: Poller | null = null;

/** Telegram answers 409 Conflict while a webhook is set. */
function isWebhookConflict(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 409;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Fetch and handle updates until the loop is stopped or a webhook takes over. */
async function pollForUpdates(bot: TelegramBotConfig, signal: AbortSignal): Promise<void> {
  const api = createBot(bot.encryptedToken).api;
  let offset = 0;

  while (!signal.aborted) {
    let updates;
    try {
      // grammy types the signal against Node's polyfill; it takes a plain
      // AbortSignal at runtime.
      updates = await api.getUpdates(
        { offset, timeout: POLL_TIMEOUT_SECONDS, limit: POLL_LIMIT },
        signal as never,
      );
    } catch (err) {
      if (signal.aborted) return;
      if (isWebhookConflict(err)) {
        // The instance got a webhook after all. It is now the better path.
        stopPolling("a webhook is set");
        return;
      }
      console.error("Telegram getUpdates failed, retrying:", err);
      await sleep(POLL_RETRY_DELAY_MS, signal);
      continue;
    }

    for (const update of updates) {
      // Confirm before handling: a crash mid-run replays nothing, and a run
      // that fails is reported in the chat by the processor itself.
      offset = update.update_id + 1;
      await handleTelegramUpdate(update, bot).catch((err) => {
        console.error(`Failed to handle Telegram update ${update.update_id}:`, err);
      });
    }
  }
}

function startPolling(bot: TelegramBotConfig): void {
  stopPolling("a different bot token was saved");

  const controller = new AbortController();
  poller = { encryptedToken: bot.encryptedToken, controller };
  console.log("[telegram] No webhook is set, polling Telegram for updates");

  pollForUpdates(bot, controller.signal).catch((err) => {
    console.error("[telegram] Polling stopped unexpectedly:", err);
    if (poller?.controller === controller) poller = null;
  });
}

function stopPolling(reason: string): void {
  if (!poller) return;
  const { controller } = poller;
  poller = null;
  controller.abort();
  console.log(`[telegram] Stopped polling: ${reason}`);
}

/** The bot's registered webhook URL, or null when Telegram did not answer. */
async function readWebhookUrl(bot: TelegramBotConfig): Promise<string | null> {
  try {
    const info = await createBot(bot.encryptedToken).api.getWebhookInfo();
    return info.url ?? null;
  } catch (err) {
    console.error("Failed to read the Telegram webhook info:", err);
    return null;
  }
}

/**
 * Put delivery back where it belongs: a webhook when the bot has one, polling
 * when it does not. Safe to call repeatedly.
 */
export async function reconcileTelegramDelivery(): Promise<void> {
  const bot = await getEnabledTelegramBot();
  if (!bot) {
    stopPolling("the bot is off");
    return;
  }

  if (poller?.encryptedToken === bot.encryptedToken) return;

  const webhookUrl = await readWebhookUrl(bot);
  // Telegram did not answer, so its state is unknown. Leave delivery as it is
  // rather than starting a poll that would fight a webhook.
  if (webhookUrl === null) return;

  if (webhookUrl) {
    stopPolling("a webhook is set");
    return;
  }

  startPolling(bot);
}

/**
 * Keep the bot's delivery mode in step with what Telegram accepted. Runs once
 * at worker startup and then on an interval, so saving a token on an instance
 * Telegram cannot reach starts polling without a restart.
 *
 * Returns a stop function for shutdown.
 */
export function startTelegramDeliveryWatcher(): () => void {
  const tick = () => {
    reconcileTelegramDelivery().catch((err) => {
      console.error("Failed to reconcile Telegram delivery:", err);
    });
  };

  tick();
  const timer = setInterval(tick, DELIVERY_CHECK_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    stopPolling("the worker is shutting down");
  };
}
