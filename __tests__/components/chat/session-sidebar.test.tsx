// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";
import { LONG_PRESS_MS } from "@/hooks/use-long-press";

/**
 * The sidebar keeps recent chats in the open and folds idle ones (>5 days)
 * into a card, so a long history never buries the chats you are actually in.
 */

const { routerMock, toastError } = vi.hoisted(() => ({
  routerMock: { push: vi.fn() },
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function iso(daysAgo: number) {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

function session(id: string, title: string, daysAgo: number, watcherCount = 0) {
  return {
    id,
    title,
    temporary: false,
    messageCount: 3,
    watcherCount,
    createdAt: iso(daysAgo + 1),
    updatedAt: iso(daysAgo),
    lastActivityAt: iso(daysAgo),
  };
}

const SESSIONS = [
  session("s-fresh", "Fresh chat", 0.2),
  session("s-recent", "Recent chat", 3),
  session("s-stale", "Stale chat", 9),
  session("s-ancient", "Ancient chat", 40),
];

let fetchMock: ReturnType<typeof vi.fn>;

/** Server answer for a bulk delete  ids that went, ids that did not. */
type BulkResponse = {
  deleted: string[];
  failed: Array<{ sessionId: string; error: string; code?: string }>;
};

function mockSessions(sessions = SESSIONS, bulk?: BulkResponse | BulkResponse[]) {
  // A list of answers answers one request each. the second one is the retry.
  const answers = Array.isArray(bulk) ? [...bulk] : null;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat/sessions/bulk") {
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[]; force?: boolean };
      const answer = answers?.shift() ?? bulk ?? { deleted: ids, failed: [] };
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    expect(url).toBe("/api/chat/sessions");
    return new Response(JSON.stringify({ sessions }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The row's main button  the click target that opens (or selects) a chat. */
function rowButton(title: string) {
  return screen.getByText(title).closest("button") as HTMLElement;
}

async function renderSidebar(activeSessionId?: string, expected = "Fresh chat") {
  const view = render(<SessionSidebar {...(activeSessionId ? { activeSessionId } : {})} />);
  await screen.findByText(expected);
  return view;
}

/** Open a row's action menu (the ⋯ button lives behind a hover state on pointer devices). */
async function revealRowActions(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${title}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessions();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionSidebar older chats", () => {
  it("keeps idle chats out of the list until the card is opened", async () => {
    await renderSidebar();

    expect(screen.getByText("Fresh chat")).toBeInTheDocument();
    expect(screen.getByText("Recent chat")).toBeInTheDocument();
    expect(screen.getByText("Older chats")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("Stale chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Ancient chat")).not.toBeInTheDocument();
  });

  it("reveals idle chats when the card is opened and hides them again", async () => {
    await renderSidebar();

    const trigger = screen.getByRole("button", { name: "Show older chats" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(await screen.findByText("Stale chat")).toBeInTheDocument();
    expect(screen.getByText("Ancient chat")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide older chats" }));

    await waitFor(() => expect(screen.queryByText("Stale chat")).not.toBeInTheDocument());
    expect(screen.getByText("Fresh chat")).toBeInTheDocument();
  });

  it("opens an idle chat from inside the card", async () => {
    await renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    const row = await screen.findByText("Ancient chat");
    fireEvent.click(row.closest("button") as HTMLElement);

    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/chat/s-ancient");
  });

  it("starts folded shut while the active chat is recent", async () => {
    await renderSidebar("s-recent");

    expect(screen.queryByText("Stale chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show older chats" })).toBeInTheDocument();
  });

  it("auto-opens the card when the active chat is idle", async () => {
    await renderSidebar("s-stale");

    expect(await screen.findByText("Stale chat")).toBeInTheDocument();
    expect(screen.getByText("Ancient chat")).toBeInTheDocument();
    // The active chat is not distinguishable from the other idle ones by text,
    // so assert on the accent fill of its row.
    expect(screen.getByText("Stale chat").closest("div.group")).toHaveClass("bg-accent/70");
  });

  it("shows idle chats with no recent history instead of an empty list", async () => {
    mockSessions([session("s-only", "Only chat", 12)]);

    await renderSidebar(undefined, "Only chat");

    expect(screen.getByText("Only chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide older chats" })).toBeInTheDocument();
  });

  it("deletes an idle chat from inside the card through the confirmation box", async () => {
    await renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    await revealRowActions("Stale chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));

    expect(await screen.findByText("Delete 1 chat?")).toBeInTheDocument();
    // Cancelling must not touch the chat.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Stale chat")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await revealRowActions("Stale chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Stale chat")).not.toBeInTheDocument());
    expect(screen.getByText("Ancient chat")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["s-stale"] }),
      }),
    );
  });

  it("warns in the confirmation box when the chat has watchers attached", async () => {
    mockSessions([session("s-watch", "Watched chat", 0.2, 2)]);

    await renderSidebar(undefined, "Watched chat");
    await revealRowActions("Watched chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));

    const box = await screen.findByText("Delete 1 chat?");
    const description = box.closest("[role=alertdialog]") as HTMLElement;
    expect(description.textContent).toContain("2 watchers");
    expect(description.textContent).toContain("scheduled checks stop immediately");
  });

  it("asks again before discarding a checkout's uncommitted changes", async () => {
    mockSessions(SESSIONS, [
      {
        deleted: [],
        failed: [
          {
            sessionId: "s-fresh",
            error: "fatal: contains modified or untracked files, use --force to delete it",
            code: WORKTREE_KEPT_CODE,
          },
        ],
      },
      { deleted: ["s-fresh"], failed: [] },
    ]);
    await renderSidebar();

    await revealRowActions("Fresh chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    // git refused, so the box stays open and names what is at stake.
    const again = await screen.findByRole("button", { name: "Delete anyway" });
    expect(screen.getByText(/discarding this chat's uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText("Fresh chat")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.click(again);

    await waitFor(() => expect(screen.queryByText("Fresh chat")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/chat/sessions/bulk",
      expect.objectContaining({ body: JSON.stringify({ ids: ["s-fresh"], force: true }) }),
    );
  });

  it("shows a failure it cannot force instead of offering a retry", async () => {
    mockSessions(SESSIONS, {
      deleted: [],
      failed: [{ sessionId: "s-fresh", error: "Chat not found: s-fresh" }],
    });
    await renderSidebar();

    await revealRowActions("Fresh chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Chat not found: s-fresh")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument();
    expect(screen.getByText("Fresh chat")).toBeInTheDocument();
  });

  it("offers every row's delete action without a hover state", async () => {
    // Touch devices cannot hover, so the row action must exist in the DOM for
    // every row (its CSS keeps it visible when there is no pointer).
    await renderSidebar();

    for (const title of ["Fresh chat", "Recent chat"]) {
      const trigger = screen.getByRole("button", { name: `Actions for ${title}` });
      expect(trigger).toHaveClass("any-pointer-coarse:opacity-100");
    }
  });
});

describe("SessionSidebar multi-select", () => {
  it("picks several chats with ctrl-click and deletes them in one request", async () => {
    await renderSidebar();

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    fireEvent.click(rowButton("Recent chat"), { ctrlKey: true });

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    // Picking a chat is not opening it.
    expect(routerMock.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete 2 selected chats" }));
    expect(await screen.findByText("Delete 2 chats?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Fresh chat")).not.toBeInTheDocument());
    expect(screen.queryByText("Recent chat")).not.toBeInTheDocument();
    // The selection ends with the deleted chats  the toolbar goes back to a title.
    expect(screen.getByText("Conversations")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["s-fresh", "s-recent"] }),
      }),
    );
  });

  it("toggles a chat when the tap lands on its selection box", async () => {
    await renderSidebar();

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    const box = rowButton("Recent chat").querySelector('[data-slot="selection-indicator"]');
    expect(box).not.toBeNull();

    // The box is part of the row's single target  one tap, one toggle.
    fireEvent.click(box as HTMLElement);
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(box as HTMLElement);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("toggles a chat off by tapping it, and stops selecting with the last one", async () => {
    await renderSidebar();

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    fireEvent.click(rowButton("Recent chat"), { ctrlKey: true });

    // A plain tap inside a selection toggles, so the rows stay reachable there.
    fireEvent.click(rowButton("Fresh chat"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalled();

    fireEvent.click(rowButton("Recent chat"));
    expect(screen.getByText("Conversations")).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("starts a selection from the row menu and marks the picked rows", async () => {
    await renderSidebar();

    await revealRowActions("Fresh chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Select chat" }));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(rowButton("Fresh chat")).toHaveAttribute("aria-pressed", "true");
    expect(rowButton("Recent chat")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the row you held selected without opening it", async () => {
    await renderSidebar();

    vi.useFakeTimers();
    const row = rowButton("Fresh chat");
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // Browsers still send the click that follows the hold; it must not open the chat.
    fireEvent.click(row);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("drops the hold when the finger scrolls instead", async () => {
    await renderSidebar();

    vi.useFakeTimers();
    const row = rowButton("Fresh chat");
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerType: "touch", clientX: 10, clientY: 80 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/chat/s-fresh");
  });

  it("exits the selection with Escape", async () => {
    await renderSidebar();

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Conversations")).toBeInTheDocument();
  });

  it("leaves the chat view when the open chat is among the deleted", async () => {
    await renderSidebar("s-fresh");

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 selected chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/dashboard/chat"));
  });

  it("keeps a chat that failed to delete selected for a retry", async () => {
    mockSessions(SESSIONS, {
      deleted: ["s-fresh"],
      failed: [{ sessionId: "s-recent", error: "Chat not found: s-recent" }],
    });
    await renderSidebar();

    fireEvent.click(rowButton("Fresh chat"), { ctrlKey: true });
    fireEvent.click(rowButton("Recent chat"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 selected chats" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Fresh chat")).not.toBeInTheDocument());
    expect(screen.getByText("Recent chat")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("1 of 2"));
  });
});
