// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The setup flow, which is also the coder module's onboarding.
 *
 * What it has to get right: every answer from the three steps reaches the
 * create call in one request, and a first prompt comes back to the caller to
 * start a chat with.
 */

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock("@/lib/http", () => ({ postJson: mocks.postJson }));

import { ProjectCreateDialog } from "@/components/coder/project-create-dialog";

const PROJECT = { id: "project-1", name: "Saale Web", defaultBranch: "main", chatMode: "worktree" };

function setup(onCreated = vi.fn()) {
  render(<ProjectCreateDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
  return onCreated;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postJson.mockResolvedValue({ project: PROJECT });
});

describe("ProjectCreateDialog", () => {
  it("sends the repo, the checkout choice and the script in one create", async () => {
    const onCreated = setup();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saale Web" } });
    fireEvent.change(screen.getByLabelText("Clone URL"), {
      target: { value: "https://github.com/owner/repo.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(await screen.findByRole("switch", { name: "Own worktree per chat" }));
    fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "develop" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.change(await screen.findByLabelText("Setup script"), {
      target: { value: "npm install" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(mocks.postJson).toHaveBeenCalledWith("/api/coder/projects", {
        name: "Saale Web",
        cloneUrl: "https://github.com/owner/repo.git",
        chatMode: "repo",
        defaultBranch: "develop",
        setupScript: "npm install",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({ project: PROJECT, prompt: null });
  });

  it("hands a first prompt back to the caller to start a chat with", async () => {
    const onCreated = setup();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saale Web" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(await screen.findByLabelText("First prompt"), {
      target: { value: "  Read the repo and tell me what it does.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        project: PROJECT,
        prompt: "Read the repo and tell me what it does.",
      }),
    );
  });

  it("stays on the first step until the project has a name", async () => {
    setup();

    fireEvent.change(screen.getByLabelText("Clone URL"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Give the project a name.")).toBeInTheDocument();
    expect(mocks.postJson).not.toHaveBeenCalled();
  });

  it("names the project after the clone URL when the name is left empty", async () => {
    const onCreated = setup();

    fireEvent.change(screen.getByLabelText("Clone URL"), {
      target: { value: "https://github.com/owner/saale-web.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(mocks.postJson).toHaveBeenCalledWith(
        "/api/coder/projects",
        expect.objectContaining({ name: "saale-web", chatMode: "worktree" }),
      ),
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it("keeps the flow open with the server's reason", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.postJson.mockRejectedValue(new Error("The branch develop is not in this repo"));
    setup();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saale Web" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create project" }));

    expect(await screen.findByText("The branch develop is not in this repo")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    error.mockRestore();
  });
});
