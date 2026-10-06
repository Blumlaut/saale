// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useRef } from "react";
import { ChatInterface } from "@/components/chat/chat-interface";
import { InputBar, type InputBarHandle } from "@/components/chat/input-bar";
import { useFileDrop } from "@/hooks/use-file-drop";
import { installMemoryStorage } from "../../helpers/memory-storage";

/**
 * Dropping files on the chat.
 *
 * The composer already takes files through the paperclip and through a paste;
 * a drop is the third way in and has to land in the same pending strip. The
 * drag also has to be *claimed* — an unhandled file drop makes the browser
 * navigate the tab to the file, which would throw away the draft and any
 * running generation.
 */

const { routerMock } = vi.hoisted(() => ({ routerMock: { push: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
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

/** POST bodies the composer sent, as the server would read them. */
let sentBodies: FormData[] = [];

function fetchMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";

  if (url === `/api/chat/sessions/${SESSION_ID}/messages` && method === "POST") {
    sentBodies.push(init?.body as FormData);
    return Promise.resolve(
      json({
        ok: true,
        queued: false,
        message: {
          id: "db-1",
          role: "user",
          content: "look at this",
          createdAt: "2026-01-01T00:00:00.000Z",
          attachments: [],
        },
      }),
    );
  }
  if (url === `/api/chat/sessions/${SESSION_ID}/messages`) {
    return Promise.resolve(json({ messages: [], queuedMessages: [], session: { id: SESSION_ID } }));
  }
  if (url === `/api/chat/sessions/${SESSION_ID}`) {
    return Promise.resolve(json({ session: { title: "Test chat" } }));
  }
  if (url === "/api/chat/sessions") return Promise.resolve(json({ sessions: [] }));

  return Promise.resolve(json({}));
}

/** A DataTransfer carrying `files`, as a drop from the desktop provides. */
function transfer(files: File[], types: string[] = ["Files"]) {
  return { types, files, dropEffect: "none", items: [] };
}

function droppedFile(name: string, type = "text/csv", size = 16) {
  return new File([new Uint8Array(size)], name, { type });
}

/**
 * Dispatch a drag event the way a browser emits it.
 *
 * jsdom drops `relatedTarget` (and `dataTransfer`) from the event init, so
 * both are attached to a plain event — `relatedTarget` is what distinguishes
 * "moved onto another element inside the zone" from "left the window".
 */
function dispatchDrag(
  target: Element | Window,
  type: string,
  options: { files: File[]; types?: string[]; relatedTarget?: Element | null },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: transfer(options.files, options.types),
  });
  if (options.relatedTarget !== undefined) {
    Object.defineProperty(event, "relatedTarget", { value: options.relatedTarget });
  }
  // Wrapped in `act` like `fireEvent` is: the drop zone re-renders on the
  // event, and the assertions below read that render.
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/**
 * The drop zone is the chat column wrapping the surface, the queue strip and
 * the composer — i.e. the surface panel's parent.
 */
function dropZone(container: HTMLElement): HTMLElement {
  const zone = container.querySelector(".glass-panel")?.parentElement;
  if (!zone) throw new Error("chat drop zone not found");
  return zone as HTMLElement;
}

beforeAll(() => {
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

beforeEach(() => {
  installMemoryStorage(window as unknown as Record<string, unknown>);
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((file: File) => `blob:fake-${file.name}`),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  MockEventSource.instances = [];
  sentBodies = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

async function mountChat() {
  const result = render(
    <ChatInterface
      sessionId={SESSION_ID}
      temporaryMode={false}
      onTemporaryChange={() => {}}
      onNewChat={() => {}}
    />,
  );
  // Let the mount fetch settle so the composer is wired to the loaded session.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

describe("dropping files on the chat", () => {
  it("shows the drop hint only while a file drag is over the chat", async () => {
    const { container } = await mountChat();
    const zone = dropZone(container);
    const csv = [droppedFile("data.csv")];
    expect(screen.queryByText("Drop files to attach")).toBeNull();

    dispatchDrag(zone, "dragenter", { files: csv });
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();

    // Crossing a child fires another enter/leave pair — the hint must not
    // flicker, and a leave that is still inside the zone must not clear it.
    const composer = screen.getByPlaceholderText("Message Saale...");
    dispatchDrag(composer, "dragenter", { files: csv });
    dispatchDrag(composer, "dragleave", { files: csv, relatedTarget: zone });
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();

    dispatchDrag(zone, "dragleave", { files: csv, relatedTarget: document.body });
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });

  it("ignores drags that carry no files", async () => {
    const { container } = await mountChat();
    const zone = dropZone(container);

    const enter = dispatchDrag(zone, "dragenter", { files: [], types: ["text/plain"] });
    const drop = dispatchDrag(zone, "drop", { files: [], types: ["text/plain"] });

    expect(screen.queryByText("Drop files to attach")).toBeNull();
    // An internal drag (selected text, the sidebar's own reorder) keeps its
    // browser default — the zone must not claim it.
    expect(enter.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
  });

  it("queues a dropped file in the composer and sends it with the message", async () => {
    const { container } = await mountChat();
    const zone = dropZone(container);
    const pdf = droppedFile("report.pdf", "application/pdf", 2048);

    const drop = dispatchDrag(zone, "drop", { files: [pdf] });

    // The drop is claimed — the browser must not open the file.
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    // …and the file waits in the composer strip, not somewhere else.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();

    const composer = screen.getByPlaceholderText("Message Saale...");
    fireEvent.change(composer, { target: { value: "look at this" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]!.get("content")).toBe("look at this");
    const attached = sentBodies[0]!.getAll("files") as File[];
    expect(attached.map((file) => file.name)).toEqual(["report.pdf"]);
    // Sent files leave the strip.
    expect(screen.queryByText("report.pdf")).toBeNull();
  });

  it("previews a dropped image as a thumbnail", async () => {
    const { container } = await mountChat();
    const zone = dropZone(container);

    dispatchDrag(zone, "drop", { files: [droppedFile("photo.png", "image/png", 64)] });

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("photo.png");
  });

  it("keeps several dropped files in order and drops them one by one", async () => {
    const { container } = await mountChat();
    const zone = dropZone(container);

    dispatchDrag(zone, "drop", {
      files: [droppedFile("first.txt", "text/plain"), droppedFile("second.txt", "text/plain")],
    });

    expect(screen.getByText("first.txt")).toBeInTheDocument();
    expect(screen.getByText("second.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove first.txt" }));
    expect(screen.queryByText("first.txt")).toBeNull();
    expect(screen.getByText("second.txt")).toBeInTheDocument();
  });

  it("swallows a file drop that lands outside the chat", async () => {
    await mountChat();

    const outside = dispatchDrag(document.body, "drop", { files: [droppedFile("x.txt")] });

    expect(outside.defaultPrevented).toBe(true);
  });
});

// ─── The hook on its own ─────────────────────────────────────────────────────

describe("useFileDrop", () => {
  function Harness({ onFiles }: { onFiles: (files: File[]) => void }) {
    const zoneRef = useRef<HTMLDivElement>(null);
    const { isDragging, dropZoneProps } = useFileDrop(onFiles);
    return (
      <div ref={zoneRef} data-testid="zone" {...dropZoneProps}>
        <span>{isDragging ? "dragging" : "idle"}</span>
        <div data-testid="child" />
      </div>
    );
  }

  it("stops highlighting when the drag leaves the window", () => {
    render(<Harness onFiles={vi.fn()} />);
    const zone = screen.getByTestId("zone");
    const files = [droppedFile("a.txt")];

    dispatchDrag(zone, "dragenter", { files });
    dispatchDrag(screen.getByTestId("child"), "dragenter", { files });
    expect(screen.getByText("dragging")).toBeInTheDocument();

    // The pointer left the document: no further dragleave reaches the zone.
    dispatchDrag(window, "dragleave", { files, relatedTarget: null });
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("takes the dropped files and clears the highlight", () => {
    const onFiles = vi.fn();
    render(<Harness onFiles={onFiles} />);
    const zone = screen.getByTestId("zone");
    const image = droppedFile("shot.png", "image/png");

    dispatchDrag(zone, "dragenter", { files: [image] });
    dispatchDrag(zone, "drop", { files: [image] });

    expect(onFiles).toHaveBeenCalledWith([image]);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("does not call back for an empty drop", () => {
    const onFiles = vi.fn();
    render(<Harness onFiles={onFiles} />);

    dispatchDrag(screen.getByTestId("zone"), "drop", { files: [] });

    expect(onFiles).not.toHaveBeenCalled();
  });
});

// ─── InputBar: the imperative entry point the drop uses ──────────────────────

describe("InputBar.addFiles", () => {
  it("adds files handed over by the chat surface", () => {
    const onSend = vi.fn();
    let handle: InputBarHandle | null = null;

    render(
      <InputBar
        ref={(instance) => {
          handle = instance;
        }}
        onSend={onSend}
        value=""
        onValueChange={() => {}}
        isLoading={false}
        onStop={() => {}}
      />,
    );

    act(() => {
      handle!.addFiles([droppedFile("notes.md", "text/markdown", 512)]);
    });

    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });
});
