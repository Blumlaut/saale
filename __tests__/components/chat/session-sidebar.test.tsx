// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionSidebar } from "@/components/chat/session-sidebar";

/**
 * The sidebar keeps recent chats in the open and folds idle ones (>5 days)
 * into a card, so a long history never buries the chats you are actually in.
 */

const { routerMock } = vi.hoisted(() => ({ routerMock: { push: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function iso(daysAgo: number) {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

function session(id: string, title: string, daysAgo: number) {
  return {
    id,
    title,
    temporary: false,
    messageCount: 3,
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

function mockSessions(sessions = SESSIONS) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    expect(url).toBe("/api/chat/sessions");
    return new Response(JSON.stringify({ sessions }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function renderSidebar(activeSessionId?: string, expected = "Fresh chat") {
  const view = render(<SessionSidebar {...(activeSessionId ? { activeSessionId } : {})} />);
  await screen.findByText(expected);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessions();
});

afterEach(() => {
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

  it("deletes an idle chat from inside the card", async () => {
    await renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Stale chat" }));

    await waitFor(() => expect(screen.queryByText("Stale chat")).not.toBeInTheDocument());
    expect(screen.getByText("Ancient chat")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/chat/sessions/s-stale", { method: "DELETE" });
  });
});
