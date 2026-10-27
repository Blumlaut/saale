// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The coder landing page.
 *
 * Each project carries the latest chats under it, so reopening the work you
 * were doing is one click. What the fold shows, what the project row still
 * does, and where the rest of a project's chats live are the point of it.
 */

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  deleteJson: vi.fn(),
  patchJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  fetchJson: mocks.fetchJson,
  deleteJson: mocks.deleteJson,
  patchJson: mocks.patchJson,
  postJson: mocks.postJson,
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

import { ProjectList } from "@/components/coder/project-list";
import { broadcastSessionsDeleted } from "@/lib/chat/session-events";

const NOW = new Date().toISOString();

function chat(id: string, title: string, pinned = false) {
  return {
    id,
    title,
    lastActivityAt: NOW,
    pinned,
    isGenerating: false,
    origin: "user",
    worktree: { path: `/worktrees/${id}`, branch: `coder/${id}`, status: "active" },
  };
}

function project(id: string, name: string, chats: unknown[], chatCount = chats.length) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    repoPath: `projects/${name.toLowerCase()}`,
    defaultBranch: "main",
    chatMode: "worktree",
    worktreeCount: 1,
    chatCount,
    lastActivityAt: NOW,
    chats,
  };
}

const PROJECTS = [
  project("p-1", "Saale Web", [chat("s-1", "Fix the build"), chat("s-2", "Read the logs")]),
  project("p-2", "Attrition", [], 0),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchJson.mockResolvedValue({ projects: PROJECTS });
  mocks.deleteJson.mockResolvedValue({ ok: true });
  mocks.patchJson.mockResolvedValue({ ok: true });
  mocks.postJson.mockResolvedValue({ session: { id: "s-new" } });
});

describe("ProjectList", () => {
  it("lists each project's latest chats under it", async () => {
    render(<ProjectList />);

    expect(await screen.findByText("Fix the build")).toBeInTheDocument();
    expect(screen.getByText("Saale Web")).toBeInTheDocument();
    expect(screen.getByText("Read the logs")).toBeInTheDocument();
    // A fold, not a section of its own: the chat sits under its project's row.
    const row = screen.getByText("Saale Web").closest("[data-slot=project-row]")!;
    const fold = screen.getByText("Fix the build").closest("[data-slot=session-row]")!;
    expect(row.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByText("Fix the build").closest("a")).toHaveAttribute(
      "href",
      "/dashboard/coder/p-1/s-1",
    );
  });

  it("shows no fold for a project without chats", async () => {
    render(<ProjectList />);

    await screen.findByText("Attrition");
    const row = screen.getByText("Attrition").closest("[data-slot=project-row]")!;
    const group = row.parentElement!;
    expect(group.querySelectorAll("[data-slot=session-row]")).toHaveLength(0);
  });

  it("sends the rest of a project's chats to the project page", async () => {
    mocks.fetchJson.mockResolvedValue({
      projects: [project("p-1", "Saale Web", [chat("s-1", "Fix the build")], 5)],
    });

    render(<ProjectList />);

    const more = await screen.findByRole("link", { name: "All 5 chats" });
    expect(more).toHaveAttribute("href", "/dashboard/coder/p-1");
  });

  it("keeps the rest of a project's chats off the page when it has no more", async () => {
    render(<ProjectList />);

    await screen.findByText("Fix the build");
    expect(screen.queryByRole("link", { name: /All \d+ chats/ })).not.toBeInTheDocument();
  });

  it("drops a chat deleted from another list, and the fold with it", async () => {
    render(<ProjectList />);
    await screen.findByText("Fix the build");

    mocks.fetchJson.mockResolvedValue({ projects: [project("p-2", "Attrition", [], 0)] });
    act(() => broadcastSessionsDeleted(["s-1"]));

    await waitFor(() => expect(screen.queryByText("Fix the build")).not.toBeInTheDocument());
  });

  it("starts a chat in the project from its row", async () => {
    render(<ProjectList />);
    await screen.findByText("Saale Web");

    fireEvent.click(screen.getByRole("button", { name: "New chat in Saale Web" }));

    await waitFor(() =>
      expect(mocks.postJson).toHaveBeenCalledWith(
        "/api/chat/sessions",
        expect.objectContaining({ projectId: "p-1" }),
      ),
    );
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/dashboard/coder/p-1/s-new"));
  });

  it("opens a folded chat through the row's link", async () => {
    render(<ProjectList />);
    const row = await screen.findByText("Read the logs");

    // The row is a link, so a click on it is a navigation, not a fetch.
    expect(row.closest("a")).toHaveAttribute("href", "/dashboard/coder/p-1/s-2");
  });
});
