// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { ChatInterface } from "@/components/chat/chat-interface";
import { installMemoryStorage } from "../../helpers/memory-storage";

/**
 * A chat the server no longer knows sends the user back to the list it came
 * from. Deleting the chat that is open does that (the delete removes the
 * session under the view), and a coder chat belongs back on its project, not in
 * the chat view.
 */

const { routerMock } = vi.hoisted(() => ({ routerMock: { push: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const SESSION_ID = "session-1";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

function fetchMock(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();

  // The session is gone: its conversation read answers 404.
  if (url === `/api/chat/sessions/${SESSION_ID}/messages`) {
    return Promise.resolve({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "Not found" }),
    } as unknown as Response);
  }
  if (url === `/api/chat/sessions/${SESSION_ID}`) {
    return Promise.resolve(json({ session: { title: "Test chat" } }));
  }
  if (url === "/api/chat/sessions") return Promise.resolve(json({ sessions: [] }));

  return Promise.resolve(json({}));
}

beforeAll(() => {
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

beforeEach(() => {
  installMemoryStorage(window as unknown as Record<string, unknown>);
  Element.prototype.scrollIntoView = vi.fn();
  MockEventSource.instances = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

async function mountChat(goneHref?: string) {
  render(
    <ChatInterface
      sessionId={SESSION_ID}
      temporaryMode={false}
      onTemporaryChange={() => {}}
      onNewChat={() => {}}
      {...(goneHref ? { goneHref } : {})}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

describe("a chat that no longer exists", () => {
  it("sends the user back to the chat list", async () => {
    await mountChat();
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/dashboard/chat"));
  });

  it("sends a coder chat back to its project", async () => {
    await mountChat("/dashboard/coder/p-1");
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/dashboard/coder/p-1"));
    expect(routerMock.push).not.toHaveBeenCalledWith("/dashboard/chat");
  });
});
