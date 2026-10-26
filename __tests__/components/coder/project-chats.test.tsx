// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * A project's chat list in the coder panel.
 *
 * It lives in the coder layout, so it outlives a navigation between chats: the
 * chat the panel just created, a title the server assigned to it, and a chat
 * deleted from another list all have to reach it without the user reloading the
 * page.
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

import { ProjectChats } from "@/components/coder/project-chats";
import { broadcastChatRenamed, broadcastSessionsDeleted } from "@/lib/chat/session-events";

const NOW = new Date("2026-02-01T12:00:00.000Z").toISOString();

const PROJECT = {
  id: "project-1",
  name: "Saale Web",
  slug: "saale-web",
  repoPath: "projects/saale-web",
  defaultBranch: "main",
  originUrl: null,
};

function chat(id: string, title: string, pinned = false) {
  return {
    id,
    title,
    lastActivityAt: NOW,
    pinned,
    isGenerating: false,
    worktree: { path: `/worktrees/${id}`, branch: `coder/${id}`, status: "active" },
  };
}

function detail(chats: Array<{ id: string; title: string; pinned?: boolean }>) {
  return {
    project: PROJECT,
    chats: chats.map(({ id, title, pinned }) => chat(id, title, pinned)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchJson.mockResolvedValue(detail([chat("s-1", "First chat")]));
  mocks.deleteJson.mockResolvedValue({ ok: true });
  mocks.patchJson.mockResolvedValue({ ok: true });
});

describe("ProjectChats", () => {
  it("loads the project's chats", async () => {
    render(<ProjectChats projectId={PROJECT.id} />);

    expect(await screen.findByText("First chat")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenCalledWith("/api/coder/projects/project-1");
  });

  it("re-reads the list when another chat becomes the open one", async () => {
    const { rerender } = render(<ProjectChats projectId={PROJECT.id} activeSessionId="s-1" />);
    await screen.findByText("First chat");

    // The chat the header created: its row is only on the server, so opening it
    // is what brings the list back in step.
    mocks.fetchJson.mockResolvedValue(
      detail([chat("s-2", "Fresh coder chat"), chat("s-1", "First chat")]),
    );
    rerender(<ProjectChats projectId={PROJECT.id} activeSessionId="s-2" />);

    expect(await screen.findByText("Fresh coder chat")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("picks up a title the server assigned to the open chat", async () => {
    mocks.fetchJson.mockResolvedValue(detail([chat("s-1", "New Chat")]));
    render(<ProjectChats projectId={PROJECT.id} activeSessionId="s-1" />);
    await screen.findByText("New Chat");

    // A first message names the chat server-side, and the conversation's own
    // reload announces it.
    mocks.fetchJson.mockResolvedValue(detail([chat("s-1", "Fix the sidebar refresh")]));
    act(() => broadcastChatRenamed());

    expect(await screen.findByText("Fix the sidebar refresh")).toBeInTheDocument();
  });

  it("drops a chat deleted from the other list", async () => {
    mocks.fetchJson.mockResolvedValue(
      detail([
        { id: "s-1", title: "First chat" },
        { id: "s-2", title: "Second chat" },
      ]),
    );
    render(<ProjectChats projectId={PROJECT.id} activeSessionId="s-1" />);
    await screen.findByText("Second chat");

    mocks.fetchJson.mockResolvedValue(detail([{ id: "s-1", title: "First chat" }]));
    act(() => broadcastSessionsDeleted(["s-2"]));

    await waitFor(() => expect(screen.queryByText("Second chat")).not.toBeInTheDocument());
  });

  it("sticks a pinned chat above the others and unpins it from its menu", async () => {
    mocks.fetchJson.mockResolvedValue(
      detail([chat("s-1", "First chat"), { ...chat("s-2", "Second chat"), pinned: true }]),
    );
    render(<ProjectChats projectId={PROJECT.id} activeSessionId="s-1" />);

    await screen.findByText("Second chat");
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    const pinnedRow = screen.getByText("Second chat").closest("[data-slot=session-row]")!;
    const plainRow = screen.getByText("First chat").closest("[data-slot=session-row]")!;
    expect(pinnedRow.compareDocumentPosition(plainRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions for Second chat" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin chat" }));

    expect(mocks.patchJson).toHaveBeenCalledWith("/api/chat/sessions/s-2", { pinned: false });
    // The pin event is what brings the new order back from the server.
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalledTimes(2));
  });
});
