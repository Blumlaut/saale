import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** In-memory stand-in for the Redis client the login transport uses. */
class FakeRedis {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed++;
      if (this.lists.delete(key)) removed++;
    }
    return removed;
  }
  async rpush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async lpop(key: string) {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }
  multi() {
    const queue: (() => unknown)[] = [];
    const chain = {
      set: (key: string, value: string) => {
        queue.push(() => this.set(key, value));
        return chain;
      },
      expire: (key: string) => {
        queue.push(() => (this.values.has(key) ? 1 : 0));
        return chain;
      },
      exec: async () => {
        for (const operation of queue) await operation();
        return [];
      },
    };
    return chain;
  }
}

const redis = new FakeRedis();
vi.mock("@/lib/redis", () => ({
  getRedis: () => redis,
}));

/**
 * A stand-in for Pi's runtime whose `login` runs the real interaction protocol:
 * it prompts, waits for the answer, and only then resolves.
 */
const createRuntime = vi.fn();
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: (...args: unknown[]) => createRuntime(...args) },
}));

/** The credential store the login flow is given; its writes are recorded. */
const storeModify = vi.fn();
vi.mock("@/lib/providers/credential-store", () => ({
  createProviderCredentialStore: () => ({
    read: async () => undefined,
    list: async () => [],
    modify: storeModify,
    delete: async () => undefined,
  }),
}));

import {
  answerProviderLogin,
  cancelProviderLogin,
  readProviderLogin,
  startProviderLogin,
} from "@/lib/providers/login";

type LoginState = NonNullable<Awaited<ReturnType<typeof readProviderLogin>>>;

/** Wait for the state to satisfy `predicate`, or fail the test. */
async function waitFor(
  id: string,
  predicate: (state: LoginState) => boolean,
  scope: { kind: "user"; userId: string } | { kind: "global" } = {
    kind: "user",
    userId: "user-1",
  },
): Promise<LoginState> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await readProviderLogin(scope, id);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the sign-in state");
}

const userScope = { kind: "user" as const, userId: "user-1" };

describe("provider sign-in transport", () => {
  beforeEach(() => {
    redis.values.clear();
    redis.lists.clear();
    createRuntime.mockReset();
    storeModify.mockReset();
    storeModify.mockImplementation(async (_providerId, fn) => {
      const credential = await fn(undefined);
      return credential;
    });
  });

  it("drives Pi's prompt, stores what it answered, and reports success", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        interaction: {
          prompt: (prompt: { type: string; message: string }) => Promise<string>;
          notify: (event: { type: string; message?: string }) => void;
        },
      ) => {
        interaction.notify({ type: "progress", message: "Opening the provider" });
        const key = await interaction.prompt({ type: "secret", message: "Enter the API key" });
        await interaction.prompt({ type: "text", message: "Enter the account id" });
        return { type: "api_key", key };
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "cloudflare-ai-gateway",
      authType: "api_key",
    });

    const first = await waitFor(id, (state) => state.prompt !== null);
    expect(first.providerId).toBe("cloudflare-ai-gateway");
    expect(first.prompt).toMatchObject({ seq: 1, kind: "secret", message: "Enter the API key" });
    // Started and still running: the browser sees the flow, not a blank state.
    expect(first.status).toBe("pending");
    expect(first.events).toContainEqual({ kind: "progress", message: "Opening the provider" });

    await answerProviderLogin(userScope, id, first.prompt!.seq, "cf-key");

    // The flow moved on to its next question.
    const second = await waitFor(id, (state) => state.prompt?.seq === 2);
    expect(second.prompt).toMatchObject({ kind: "text", message: "Enter the account id" });

    await answerProviderLogin(userScope, id, second.prompt!.seq, "account-1");

    const done = await waitFor(id, (state) => state.status !== "pending");
    expect(done.status).toBe("succeeded");
    expect(done.prompt).toBeNull();
    expect(done.error).toBeNull();
  });

  it("publishes the auth URL and the device code the flow emitted", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        interaction: {
          prompt: (prompt: { type: string; message: string }) => Promise<string>;
          notify: (event: unknown) => void;
        },
      ) => {
        interaction.notify({
          type: "device_code",
          userCode: "WDJB-MJHT",
          verificationUri: "https://example.com/device",
          expiresInSeconds: 900,
        });
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/authorize?state=abc",
          instructions: "Sign in, then paste the redirect URL",
        });
        await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
        return { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 3_600_000 };
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "anthropic",
      authType: "oauth",
    });

    const state = await waitFor(id, (current) => current.prompt !== null);
    expect(state.events).toContainEqual({
      kind: "device_code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.com/device",
      expiresInSeconds: 900,
    });
    expect(state.events).toContainEqual({
      kind: "auth_url",
      url: "https://example.com/authorize?state=abc",
      instructions: "Sign in, then paste the redirect URL",
    });
    expect(state.prompt).toMatchObject({ kind: "manual_code" });
  });

  it("reports a failure with the provider's own message", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async () => {
        throw new Error("OpenAI does not support api_key login");
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "openai-codex",
      authType: "api_key",
    });

    const state = await waitFor(id, (current) => current.status !== "pending");
    expect(state.status).toBe("failed");
    expect(state.error).toBe("OpenAI does not support api_key login");
  });

  it("stops a flow that is cancelled, and does not report it as a failure", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        interaction: { prompt: (prompt: { type: string; message: string }) => Promise<string> },
      ) => {
        // A prompt that is never answered — the user closes the sheet instead.
        await interaction.prompt({ type: "manual_code", message: "Paste the code" });
        return { type: "api_key", key: "never" };
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "anthropic",
      authType: "oauth",
    });
    await waitFor(id, (state) => state.prompt !== null);

    await cancelProviderLogin(userScope, id);

    const state = await waitFor(id, (current) => current.status !== "pending");
    expect(state.status).toBe("cancelled");
    expect(state.error).toBeNull();
  });

  it("refuses an answer to a step the flow has already left", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        interaction: { prompt: (prompt: { type: string; message: string }) => Promise<string> },
      ) => {
        await interaction.prompt({ type: "text", message: "First" });
        await interaction.prompt({ type: "text", message: "Second" });
        return { type: "api_key", key: "k" };
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "groq",
      authType: "api_key",
    });
    const first = await waitFor(id, (state) => state.prompt?.seq === 1);
    await answerProviderLogin(userScope, id, first.prompt!.seq, "one");

    const second = await waitFor(id, (state) => state.prompt?.seq === 2);
    // A stale tab answering step 1 must not answer step 2.
    await expect(answerProviderLogin(userScope, id, 1, "late")).rejects.toThrow(
      "no longer waiting for an answer",
    );
    expect(second.prompt?.seq).toBe(2);
  });

  it("keeps a user's sign-in invisible to another user", async () => {
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        interaction: { prompt: (prompt: { type: string; message: string }) => Promise<string> },
      ) => {
        await interaction.prompt({ type: "text", message: "First" });
        return { type: "api_key", key: "k" };
      },
    }));

    const id = await startProviderLogin({
      scope: userScope,
      providerId: "groq",
      authType: "api_key",
    });
    await waitFor(id, (state) => state.prompt !== null);

    await expect(
      readProviderLogin({ kind: "user", userId: "user-2" }, id),
    ).resolves.toBeUndefined();
    await expect(readProviderLogin({ kind: "global" }, id)).resolves.toBeUndefined();
  });

  it("gives each scope its own device id, and none of them the user id itself", async () => {
    const deviceIds: string[] = [];
    createRuntime.mockImplementation(async () => ({
      login: async (
        _providerId: string,
        _authType: string,
        _interaction: unknown,
        options: { getDeviceId: () => string },
      ) => {
        deviceIds.push(options.getDeviceId());
        return { type: "api_key", key: "k" };
      },
    }));

    // Twice for the user (the id must survive a restart), once for the global
    // configuration (which is a different installation).
    for (const scope of [userScope, { kind: "global" as const }, userScope]) {
      const id = await startProviderLogin({ scope, providerId: "openai", authType: "oauth" });
      await waitFor(id, (state) => state.status === "succeeded", scope);
    }

    expect(deviceIds).toHaveLength(3);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const deviceId of deviceIds) {
      expect(deviceId).toMatch(uuid);
      expect(deviceId).not.toContain("user-1");
    }
    expect(deviceIds[0]).toBe(deviceIds[2]);
    expect(deviceIds[0]).not.toBe(deviceIds[1]);
  });
});
