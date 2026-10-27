// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The coder landing page's recent chats.
 *
 * This is the one-click way into a chat, so what it shows matters more than
 * where it sits: the latest chats of every project, the project each belongs
 * to, and a row that opens without a detour. "Show more" widens the window the
 * server is asked for rather than paging, and a delete lands everywhere at once.
 */

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  deleteJson: vi.fn(),
  patchJson: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  fetchJson: mocks.fetchJson,
  deleteJson: mocks.deleteJson,
  patchJson: mocks.patchJson,
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

import { RecentChats } from "@/components/coder/recent-chats";
import { broadcastSessionsDeleted } from "@/lib/chat/session-events";

const NOW = new Date().toISOString();

function chat(id: string, title: string, projectName = "Saale Web", pinned = false) {
  return {
    id,
    title,
    lastActivityAt: NOW,
    pinned,
    isGenerating: false,
    worktree: { path: `/worktrees/${id}`, branch: `coder/${id}`, status: "active" },
    project: {
      id: `p-${projectName.toLowerCase().replace(/\s/g, "-")}`,
      name: projectName,
      slug: "slug",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchJson.mockResolvedValue({ chats: [chat("s-1", "First chat")], hasMore: false });
  mocks.deleteJson.mockResolvedValue({ ok: true });
  mocks.patchJson.mockResolvedValue({ ok: true });
});

describe("RecentChats", () => {
  it("shows the latest chats with the project each belongs to", async () => {
    mocks.fetchJson.mockResolvedValue({
      chats: [chat("s-1", "Fix the build", "Saale Web"), chat("s-2", "Read the logs", "Attrition")],
      hasMore: false,
    });

    render(<RecentChats />);

    expect(await screen.findByText("Fix the build")).toBeInTheDocument();
    expect(screen.getByText("Saale Web")).toBeInTheDocument();
    expect(screen.getByText("Attrition")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenCalledWith("/api/coder/chats?limit=8");
    expect(screen.getByText("Fix the build").closest("a")).toHaveAttribute(
      "href",
      "/dashboard/coder/p-saale-web/s-1",
    );
  });

  it("stays out of the way when there is nothing to show", async () => {
    mocks.fetchJson.mockResolvedValue({ chats: [], hasMore: false });

    render(<RecentChats />);

    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled());
    expect(screen.queryByText("Recent chats")).not.toBeInTheDocument();
  });

  it("asks for a wider window when the user wants more", async () => {
    mocks.fetchJson.mockResolvedValue({ chats: [chat("s-1", "First chat")], hasMore: true });
    render(<RecentChats />);
    await screen.findByText("First chat");

    mocks.fetchJson.mockResolvedValue({
      chats: [chat("s-1", "First chat"), chat("s-2", "Second chat")],
      hasMore: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show more chats" }));

    expect(await screen.findByText("Second chat")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenLastCalledWith("/api/coder/chats?limit=16");
    expect(screen.queryByRole("button", { name: "Show more chats" })).not.toBeInTheDocument();
  });

  it("drops a chat deleted from another list", async () => {
    mocks.fetchJson.mockResolvedValue({
      chats: [chat("s-1", "First chat"), chat("s-2", "Second chat")],
      hasMore: false,
    });
    render(<RecentChats />);
    await screen.findByText("Second chat");

    mocks.fetchJson.mockResolvedValue({ chats: [chat("s-1", "First chat")], hasMore: false });
    act(() => broadcastSessionsDeleted(["s-2"]));

    await waitFor(() => expect(screen.queryByText("Second chat")).not.toBeInTheDocument());
  });

  it("deletes a chat from its row menu", async () => {
    mocks.fetchJson.mockResolvedValue({ chats: [chat("s-1", "First chat")], hasMore: false });
    render(<RecentChats />);
    await screen.findByText("First chat");

    fireEvent.click(screen.getByRole("button", { name: "Actions for First chat" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mocks.deleteJson).toHaveBeenCalledWith("/api/chat/sessions/s-1"));
  });

  it("pins a chat through the shared pin call", async () => {
    mocks.fetchJson.mockResolvedValue({ chats: [chat("s-1", "First chat")], hasMore: false });
    render(<RecentChats />);
    await screen.findByText("First chat");

    fireEvent.click(screen.getByRole("button", { name: "Actions for First chat" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin chat" }));

    await waitFor(() =>
      expect(mocks.patchJson).toHaveBeenCalledWith("/api/chat/sessions/s-1", { pinned: true }),
    );
  });
});
