// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * A project's settings panel.
 *
 * What it has to get right: it loads what the project already has, sends only
 * what the user changed with the panel, and keeps the box open when the server
 * refuses so the reason is visible next to the field that caused it.
 */

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn(), patchJson: vi.fn() }));

vi.mock("@/lib/http", () => ({
  fetchJson: mocks.fetchJson,
  patchJson: mocks.patchJson,
}));

import { ProjectSettingsSheet } from "@/components/coder/project-settings-sheet";

const PROJECT = {
  id: "project-1",
  name: "Saale Web",
  slug: "saale-web",
  repoPath: "projects/saale-web",
  defaultBranch: "main",
  setupScript: "npm install",
  envFiles: [{ path: ".env.local", content: "A=1\n" }],
};

function setup(onOpenChange = vi.fn(), onSaved = vi.fn()) {
  render(
    <ProjectSettingsSheet
      projectId={PROJECT.id}
      open
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />,
  );
  return { onOpenChange, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchJson.mockResolvedValue({ project: PROJECT });
  mocks.patchJson.mockResolvedValue({ project: PROJECT });
});

describe("ProjectSettingsSheet", () => {
  it("loads the project's current settings", async () => {
    setup();

    expect(await screen.findByDisplayValue("Saale Web")).toBeInTheDocument();
    expect(screen.getByDisplayValue("main")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenCalledWith("/api/coder/projects/project-1");
  });

  it("saves the env files, keeping the ones it loaded", async () => {
    const { onSaved, onOpenChange } = setup();
    await screen.findByDisplayValue("Saale Web");

    fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add file" }));
    fireEvent.change(screen.getAllByLabelText("Env file path")[1]!, {
      target: { value: "apps/web/.env" },
    });
    fireEvent.change(screen.getAllByLabelText("Contents of apps/web/.env")[0]!, {
      target: { value: "API=1\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.patchJson).toHaveBeenCalledWith("/api/coder/projects/project-1", {
      name: "Saale Web",
      defaultBranch: "main",
      envFiles: [
        { path: ".env.local", content: "A=1\n" },
        { path: "apps/web/.env", content: "API=1\n" },
      ],
      setupScript: "npm install",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the box open and shows why the server refused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.patchJson.mockRejectedValue(new Error("apps/web/.env cannot climb out of the checkout"));
    const { onOpenChange } = setup();
    await screen.findByDisplayValue("Saale Web");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("apps/web/.env cannot climb out of the checkout"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("sends no script when the field is emptied", async () => {
    setup();
    await screen.findByDisplayValue("Saale Web");

    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.change(await screen.findByLabelText("Run after a checkout is made"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.patchJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ setupScript: null }),
      ),
    );
  });
});
