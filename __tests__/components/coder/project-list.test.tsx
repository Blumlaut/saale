// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The coder landing page.
 *
 * Every project is one foldable line, and the chats it is working on hang under
 * it with the branch they run on and the pull request that branch is on. What a
 * line shows, what folds away, and where the rest of a project's chats live are
 * the point of it.
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

function chat(id: string, title: string, extra: { pinned?: boolean; pullRequest?: unknown } = {}) {
  return {
    id,
    title,
    lastActivityAt: NOW,
    pinned: extra.pinned ?? false,
    isGenerating: false,
    origin: "user",
    worktree: { path: `/worktrees/${id}`, branch: `wt/${id}`, status: "active" },
    pullRequest: extra.pullRequest ?? null,
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
    worktreeCount: chats.length,
    chatCount,
    lastActivityAt: chats.length > 0 ? NOW : null,
    chats,
  };
}

const PROJECTS = [
  project("p-1", "Saale Web", [chat("s-1", "Fix the build"), chat("s-2", "Read the logs")]),
  project("p-2", "Attrition", []),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
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

  it("leads a chat row with its title, and carries the branch beside it", async () => {
    render(<ProjectList />);

    const row = (await screen.findByText("Fix the build")).closest("[data-slot=session-row]")!;
    const title = row.textContent!.indexOf("Fix the build");
    const branch = row.textContent!.indexOf("wt/s-1");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThan(title);
  });

  it("draws the pull request a chat's branch is on", async () => {
    mocks.fetchJson.mockResolvedValue({
      projects: [
        project("p-1", "Saale Web", [
          chat("s-1", "Fix the build", {
            pullRequest: {
              number: 128,
              state: "MERGED",
              draft: false,
              url: "https://github.com/acme/saale/pull/128",
              checkedAt: NOW,
            },
          }),
        ]),
      ],
    });

    render(<ProjectList />);

    const badge = await screen.findByRole("link", { name: /128.*merged/i });
    expect(badge).toHaveAttribute("href", "https://github.com/acme/saale/pull/128");
    expect(badge.className).toContain("text-purple");
  });

  it("folds a project's chats away and back", async () => {
    render(<ProjectList />);
    await screen.findByText("Fix the build");

    const toggle = screen.getByRole("button", { name: "Fold Saale Web" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(screen.queryByText("Fix the build")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("saale:ui:coder:collapsedProjects")).toContain("p-1");

    fireEvent.click(screen.getByRole("button", { name: "Unfold Saale Web" }));
    expect(screen.getByText("Fix the build")).toBeInTheDocument();
  });

  it("says a project has no chats without inventing a row for it", async () => {
    render(<ProjectList />);

    await screen.findByText("Attrition");
    expect(screen.getByText("No chats yet")).toBeInTheDocument();
    const row = screen.getByText("Attrition").closest("[data-slot=project-row]")!;
    expect(row.parentElement!.querySelectorAll("[data-slot=session-row]")).toHaveLength(0);
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

    mocks.fetchJson.mockResolvedValue({ projects: [project("p-2", "Attrition", [])] });
    act(() => broadcastSessionsDeleted(["s-1"]));

    await waitFor(() => expect(screen.queryByText("Fix the build")).not.toBeInTheDocument());
  });

  it("starts a chat in the project from its line", async () => {
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

  it("opens the project from its name", async () => {
    render(<ProjectList />);
    await screen.findByText("Saale Web");

    expect(screen.getByRole("link", { name: /^Saale Web/ })).toHaveAttribute(
      "href",
      "/dashboard/coder/p-1",
    );
  });

  it("leaves a project with nothing to fold unfolded, and unmarked", async () => {
    render(<ProjectList />);

    await screen.findByText("Attrition");
    expect(screen.queryByRole("button", { name: "Fold Attrition" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unfold Attrition" })).not.toBeInTheDocument();
  });
});
