import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/providers/login", () => ({
  startProviderLogin: vi.fn(),
  readProviderLogin: vi.fn(),
  answerProviderLogin: vi.fn(),
  cancelProviderLogin: vi.fn(),
}));

import * as login from "@/lib/providers/login";
import {
  answerLoginResponse,
  cancelLoginResponse,
  loginStateResponse,
  startLoginResponse,
} from "@/lib/providers/login-api";

const scope = { kind: "user" as const, userId: "user-1" };

/** A pending sign-in, as the transport reports one. */
const pendingState = {
  id: "login-1",
  providerId: "anthropic",
  authType: "oauth" as const,
  status: "pending" as const,
  events: [],
  prompt: { seq: 1, kind: "manual_code" as const, message: "Paste the code" },
  error: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const jsonRequest = (body: unknown, method = "POST"): Request =>
  new Request("http://localhost/api/providers/login", {
    method,
    body: JSON.stringify(body),
  });

describe("provider sign-in HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a sign-in and returns its id and first state", async () => {
    vi.mocked(login.startProviderLogin).mockResolvedValue("login-1");
    vi.mocked(login.readProviderLogin).mockResolvedValue(pendingState);

    const response = await startLoginResponse(
      scope,
      jsonRequest({ provider: "anthropic", authType: "oauth" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "login-1", state: pendingState });
    expect(login.startProviderLogin).toHaveBeenCalledWith({
      scope,
      providerId: "anthropic",
      authType: "oauth",
    });
  });

  it("rejects a sign-in without a provider or with an unknown auth type", async () => {
    for (const body of [
      {},
      { provider: "anthropic" },
      { provider: "anthropic", authType: "jwt" },
    ]) {
      const response = await startLoginResponse(scope, jsonRequest(body));
      expect(response.status).toBe(400);
    }
    expect(login.startProviderLogin).not.toHaveBeenCalled();
  });

  it("reports a sign-in that failed, rather than hiding it", async () => {
    // Pi's own error (an unsupported auth type for that provider, say) reaches
    // the browser through the state.
    vi.mocked(login.startProviderLogin).mockResolvedValue("login-1");
    vi.mocked(login.readProviderLogin).mockResolvedValue({
      ...pendingState,
      status: "failed",
      prompt: null,
      error: "Cloudflare AI Gateway does not support oauth login",
    });

    const body = await (
      await startLoginResponse(scope, jsonRequest({ provider: "cloudflare", authType: "oauth" }))
    ).json();

    expect(body.state).toMatchObject({
      status: "failed",
      error: "Cloudflare AI Gateway does not support oauth login",
    });
  });

  it("returns the state of a running sign-in", async () => {
    vi.mocked(login.readProviderLogin).mockResolvedValue(pendingState);

    const response = await loginStateResponse(
      scope,
      new Request("http://localhost/api/providers/login?id=login-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: pendingState });
  });

  it("404s a sign-in the caller does not own or that has expired", async () => {
    vi.mocked(login.readProviderLogin).mockResolvedValue(undefined);

    const response = await loginStateResponse(
      scope,
      new Request("http://localhost/api/providers/login?id=someone-elses"),
    );

    expect(response.status).toBe(404);
  });

  it("requires an id to poll", async () => {
    const response = await loginStateResponse(
      scope,
      new Request("http://localhost/api/providers/login"),
    );

    expect(response.status).toBe(400);
    expect(login.readProviderLogin).not.toHaveBeenCalled();
  });

  it("accepts an answer to the step the flow is waiting on", async () => {
    vi.mocked(login.answerProviderLogin).mockResolvedValue({
      ...pendingState,
      prompt: null,
      status: "succeeded",
    });

    const response = await answerLoginResponse(
      scope,
      jsonRequest({ id: "login-1", seq: 1, value: "http://127.0.0.1:1455/auth/callback?code=abc" }),
    );

    expect(response.status).toBe(200);
    expect(login.answerProviderLogin).toHaveBeenCalledWith(
      scope,
      "login-1",
      1,
      "http://127.0.0.1:1455/auth/callback?code=abc",
    );
  });

  it("conflicts with an answer to a step that is already past", async () => {
    vi.mocked(login.answerProviderLogin).mockRejectedValue(
      new Error("That sign-in step is no longer waiting for an answer"),
    );

    const response = await answerLoginResponse(
      scope,
      jsonRequest({ id: "login-1", seq: 1, value: "x" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("no longer waiting"),
    });
  });

  it("rejects a malformed answer", async () => {
    for (const body of [{ id: "login-1" }, { id: "login-1", seq: 0, value: "x" }, {}]) {
      const response = await answerLoginResponse(scope, jsonRequest(body));
      expect(response.status).toBe(400);
    }
    expect(login.answerProviderLogin).not.toHaveBeenCalled();
  });

  it("cancels a running sign-in", async () => {
    vi.mocked(login.cancelProviderLogin).mockResolvedValue(undefined);

    const response = await cancelLoginResponse(
      scope,
      new Request("http://localhost/api/providers/login?id=login-1", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(login.cancelProviderLogin).toHaveBeenCalledWith(scope, "login-1");
  });

  it("reports a cancellation that failed instead of pretending it worked", async () => {
    vi.mocked(login.cancelProviderLogin).mockRejectedValue(new Error("redis is down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await cancelLoginResponse(
      scope,
      new Request("http://localhost/api/providers/login?id=login-1", { method: "DELETE" }),
    );

    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
