import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Pi settings for Saale agent sessions.
 *
 * Pi reads settings from the *host's* agent directory
 * (`~/.pi/agent/settings.json`, or `PI_CODING_AGENT_DIR`) and from
 * `<cwd>/.pi/settings.json`. On a server that file belongs to whoever
 * installed Pi on the machine, not to Saale: it can silently change the
 * thinking level, compaction budgets, provider retry/timeout behaviour, image
 * handling and proxy for every Saale session — and `DefaultResourceLoader`
 * resolves (and, when missing, *installs*) its `packages` list on every
 * session creation, so a broken entry there fails the whole chat.
 *
 * Sessions therefore run on an in-memory manager holding the SDK's own
 * defaults, and the app's own configuration is the only thing that shapes
 * them. Create one per session: nothing writes to it, and a shared instance
 * would let one session's mutation leak into another's.
 */
export function createSessionSettings(): SettingsManager {
  return SettingsManager.inMemory({
    // Attribution headers Pi adds to OpenRouter/NVIDIA/Cloudflare requests when
    // install telemetry is enabled (its default). Saale is not the Pi CLI, so
    // its traffic should not be attributed to pi — and nothing in this app
    // needs the headers.
    enableInstallTelemetry: false,
    // Pi warms the provider's prompt cache while a run is in flight ("streaming"
    // is its default). That is a CLI optimization for an interactive session: in
    // a hosted chat it spends extra provider requests — and money — during long
    // tool executions, and the warm-up turns are appended to the session
    // transcript as `cache_warm` usage entries.
    cacheWarming: "off",
  });
}
