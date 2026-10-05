import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionSettings } from "@/lib/pi/settings";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

/**
 * Agent sessions must not inherit the host machine's Pi installation.
 *
 * Pi's default `SettingsManager` reads `~/.pi/agent/settings.json` (or
 * `PI_CODING_AGENT_DIR`) and `<cwd>/.pi/settings.json`. On a server that file
 * belongs to whoever installed Pi there: it can set the thinking level,
 * compaction budgets, provider retries/timeouts, image handling and proxy for
 * every Saale session, and its `packages` list is resolved on every session
 * creation — an entry that needs installing turns each chat request into an
 * npm install (and fails the request when it cannot).
 *
 * Each test below sets up such a file, asserts that Pi's own manager *does*
 * read it (the control), and then that Saale's sessions do not.
 */

/** A host Pi install with settings that would visibly change a session. */
function makeHostAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-host-pi-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      defaultProvider: "llama-cpp",
      defaultModel: "some-local-model",
      defaultThinkingLevel: "high",
      enabledModels: ["llama-cpp/*"],
      images: { blockImages: true },
      retry: { maxRetries: 0 },
      sessionDir: path.join(dir, "sessions"),
      packages: ["npm:pi-mcp-adapter"],
    }),
  );
  return dir;
}

describe("session settings", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("ignores a host settings file that Pi's own manager reads", () => {
    const hostDir = makeHostAgentDir();
    process.env.PI_CODING_AGENT_DIR = hostDir;

    // Control: this is what a session would inherit if we let Pi pick.
    const host = SettingsManager.create(process.cwd(), hostDir);
    expect(host.getDefaultThinkingLevel()).toBe("high");
    expect(host.getBlockImages()).toBe(true);
    expect(host.getRetrySettings().maxRetries).toBe(0);
    expect(host.getSessionDir()).toBe(path.join(hostDir, "sessions"));

    // Subject: Saale's sessions run on the SDK's own defaults instead.
    const settings = createSessionSettings();
    expect(settings.getDefaultThinkingLevel()).toBeUndefined();
    expect(settings.getDefaultProvider()).toBeUndefined();
    expect(settings.getDefaultModel()).toBeUndefined();
    expect(settings.getBlockImages()).toBe(false);
    expect(settings.getRetrySettings().maxRetries).toBe(3);
    expect(settings.getGlobalSettings().packages).toBeUndefined();
    expect(settings.getSessionDir()).toBeUndefined();
  });

  it("does not attribute Saale's provider traffic to pi", () => {
    // With telemetry on (Pi's default) provider requests carry Pi's
    // attribution headers — HTTP-Referer/X-OpenRouter-Title to OpenRouter, a
    // billing origin to NVIDIA, a User-Agent to Cloudflare.
    const settings = createSessionSettings();
    expect(settings.getEnableInstallTelemetry()).toBe(false);
  });

  it("does not warm provider prompt caches", () => {
    // Pi's default is "streaming": it sends extra requests to warm the cache
    // while a run is in flight and records `cache_warm` usage turns in the
    // transcript. An interactive CLI wants that; a hosted chat pays for it.
    const settings = createSessionSettings();
    expect(settings.getCacheWarmingMode()).toBe("off");
  });

  it("keeps the SDK's own compaction and retry behaviour", () => {
    const settings = createSessionSettings();
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      maxAgentDelayMs: 60_000,
    });
    expect(settings.getHttpIdleTimeoutMs()).toBe(300_000);
  });

  it("builds a resource loader that serves our prompt and nothing else", async () => {
    process.env.PI_CODING_AGENT_DIR = makeHostAgentDir();

    const loader = await createSystemPromptLoader("You are Saale.", process.cwd());

    // The host's SYSTEM.md/skills/extensions/packages stay out of the session.
    expect(loader.getSystemPrompt()).toBe("You are Saale.");
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    // Saale's own inline extensions load (codemode); the host's do not.
    expect(
      loader.getExtensions().extensions.every((extension) => extension.path.includes("inline")),
    ).toBe(true);
  });
});
