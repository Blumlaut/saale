// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { toast } from "sonner";
import { ChatInterface } from "@/components/chat/chat-interface";
import { installMemoryStorage } from "../../helpers/memory-storage";

/**
 * Sending while Pi is generating must not touch the conversation.
 *
 * The optimistic copy belongs in the queue strip: rendering it as a sent
 * bubble first makes the message flash as sent (and, sitting behind the live
 * turn, swaps the streaming indicator for a bare "Thinking…" placeholder)
 * before it snaps into the queue.
 *
 * A manual compaction holds the session the same way — Pi refuses a prompt
 * until the summarization ends — so a message sent then queues too, and the
 * chat has to reconnect when the compaction ends so the server delivers it.
 */

// A stable router: a fresh object per render would change `loadMessages`'
// identity and re-run the mount effect forever.
const { routerMock } = vi.hoisted(() => ({ routerMock: { push: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// ── Controllable EventSource ─────────────────────────────────────────────────

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = MockEventSource.OPEN;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  /** Push a named SSE event, exactly as the server would. */
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

// ── API mock ─────────────────────────────────────────────────────────────────

const SESSION_ID = "session-1";

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

function dbMessage(id: string, content: string) {
  return {
    id,
    role: "user" as const,
    content,
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: undefined,
  };
}

/** What the next POST /messages answers: queued by a busy session, or prompted. */
let sendResponse: "queued" | "prompted";
/** Hold the POST open to inspect the UI while the request is in flight. */
let holdSend: boolean;
let releaseSend: (() => void) | null;
/** Same, for a manual compaction whose summarization is still running. */
let holdCompact: boolean;
let releaseCompact: (() => void) | null;

function fetchMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";

  if (url === `/api/chat/sessions/${SESSION_ID}/messages` && method === "POST") {
    const body =
      sendResponse === "queued"
        ? { ok: true, queued: true, message: dbMessage("db-queued", "just asking") }
        : { ok: true, queued: false, message: dbMessage("db-sent", "just asking") };

    if (!holdSend) return Promise.resolve(json(body));
    return new Promise<Response>((resolve) => {
      releaseSend = () => resolve(json(body));
    });
  }
  if (url === `/api/chat/sessions/${SESSION_ID}/messages`) {
    return Promise.resolve(json({ messages: [], queuedMessages: [], session: { id: SESSION_ID } }));
  }
  if (url === `/api/chat/sessions/${SESSION_ID}/compact` && method === "POST") {
    const body = { compacted: true, tokensBefore: 1000 };
    if (!holdCompact) return Promise.resolve(json(body));
    return new Promise<Response>((resolve) => {
      releaseCompact = () => resolve(json(body));
    });
  }
  if (url === `/api/chat/sessions/${SESSION_ID}`) {
    return Promise.resolve(json({ session: { title: "Test chat" } }));
  }
  if (url === "/api/jobs") return Promise.resolve(json({ jobs: [] }));

  return Promise.resolve(json({}));
}

/** Render the chat and hand back the SSE connection it opened. */
async function mountStream(): Promise<MockEventSource> {
  render(<ChatInterface sessionId={SESSION_ID} temporaryMode={false} />);
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  return MockEventSource.instances[0]!;
}

/** Start a live generation: a streaming assistant turn. */
function startGeneration(stream: MockEventSource) {
  act(() => {
    stream.emit("turn_start", { turnId: "turn-1" });
    stream.emit("token", { turnId: "turn-1", text: "Working on it" });
  });
}

/** Type into the composer and submit it. */
function sendFromComposer(text: string) {
  const composer = screen.getByPlaceholderText("Message Saale...");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

const queueStrip = () => screen.getByRole("group", { name: "Queued messages" });

/**
 * Stubbed once for the file: async effects started by one test can settle
 * during the next, and a real fetch would reject on a relative URL.
 */
beforeAll(() => {
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

beforeEach(() => {
  installMemoryStorage(window as unknown as Record<string, unknown>);
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
  MockEventSource.instances = [];
  sendResponse = "queued";
  holdSend = false;
  releaseSend = null;
  holdCompact = false;
  releaseCompact = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sending while Pi is generating", () => {
  it("queues the message without ever showing it as sent", async () => {
    const stream = await mountStream();
    startGeneration(stream);
    expect(await screen.findByText("Working on it")).toBeInTheDocument();

    holdSend = true;
    sendFromComposer("just asking");

    // While the POST is still in flight the message is already queued: exactly
    // one copy, in the queue strip.
    expect(within(queueStrip()).getByText("just asking")).toBeInTheDocument();
    expect(screen.getAllByText("just asking")).toHaveLength(1);
    expect(screen.queryByText("Thinking...")).toBeNull();

    await act(async () => {
      releaseSend?.();
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Queued", expect.anything()));

    // Settled: still one copy in the strip, and the live turn is untouched.
    expect(within(queueStrip()).getByText("just asking")).toBeInTheDocument();
    expect(screen.getAllByText("just asking")).toHaveLength(1);
    expect(screen.queryByText("Thinking...")).toBeNull();
  });

  it("moves the message into the queue strip when the server queues it anyway", async () => {
    // The client believes the session is idle (no stream events yet), so the
    // message is optimistically shown as sent — but the server is busy.
    await mountStream();
    sendFromComposer("just asking");

    await waitFor(() => expect(within(queueStrip()).getByText("just asking")).toBeInTheDocument());
    expect(screen.getAllByText("just asking")).toHaveLength(1);
  });

  it("keeps a normally sent message in the transcript", async () => {
    await mountStream();
    sendResponse = "prompted";

    sendFromComposer("just asking");

    await waitFor(() => expect(screen.getByText("just asking")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Queued messages" })).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("sending while a manual compaction holds the session", () => {
  /** Start a manual compaction whose summarization stays in flight. */
  async function startHeldCompaction() {
    holdCompact = true;
    fireEvent.click(screen.getByRole("button", { name: /Click to compact/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    await waitFor(() => expect(releaseCompact).not.toBeNull());
  }

  it("queues the message without flashing it into the conversation", async () => {
    await mountStream();
    await startHeldCompaction();

    // The composer offers to queue: what it sends now cannot be prompted until
    // the summarization ends.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Queue message" })).toBeInTheDocument(),
    );

    holdSend = true;
    sendFromComposer("sent mid-compaction");

    expect(within(queueStrip()).getByText("sent mid-compaction")).toBeInTheDocument();
    expect(screen.getAllByText("sent mid-compaction")).toHaveLength(1);
    expect(screen.queryByText("Thinking...")).toBeNull();

    await act(async () => {
      releaseSend?.();
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Queued", expect.anything()));

    await act(async () => {
      releaseCompact?.();
    });
  });

  it("reconnects when the compaction ends so the queued message is delivered", async () => {
    await mountStream();
    await startHeldCompaction();

    await act(async () => {
      releaseCompact?.();
    });

    // The stream was re-decided: the connection that watched the idle chat
    // never drains the queue, a fresh one does.
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(MockEventSource.instances[0]!.readyState).toBe(MockEventSource.CLOSED);
    expect(MockEventSource.instances[1]!.url).toBe(`/api/chat/sessions/${SESSION_ID}/stream`);
  });
});
