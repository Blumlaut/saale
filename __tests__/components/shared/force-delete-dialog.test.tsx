// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForceDeleteDialog } from "@/components/shared/force-delete-dialog";
import { forcedRetryError, WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";

/**
 * The one confirmation behind every delete that can lose uncommitted work.
 *
 * A refusal the server marks as forceable has to keep the box open and ask
 * again, because that second click is what discards the checkout.
 */

function setup(onDelete: (force: boolean) => Promise<void>, onOpenChange = vi.fn()) {
  render(
    <ForceDeleteDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this chat?"
      description="It takes the worktree with it."
      discard="this chat's uncommitted changes"
      onDelete={onDelete}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ForceDeleteDialog", () => {
  it("closes once the delete lands", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = setup(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledWith(false);
  });

  it("asks again when the refusal names work it can discard", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(forcedRetryError("fatal: contains modified or untracked files"))
      .mockResolvedValueOnce(undefined);
    const { onOpenChange } = setup(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const again = await screen.findByRole("button", { name: "Delete anyway" });
    expect(screen.getByText(/discarding this chat's uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText(/contains modified or untracked files/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(again);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenLastCalledWith(true);
  });

  it("shows a refusal it cannot override and keeps the plain button", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("Chat not found: chat-1"));
    const { onOpenChange } = setup(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Chat not found: chat-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not offer a third attempt when the forced one fails too", async () => {
    const onDelete = vi.fn().mockRejectedValue(forcedRetryError("still kept"));
    setup(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(onDelete).toHaveBeenLastCalledWith(true);
  });

  it("spins while the delete is in flight", async () => {
    let settle = () => {};
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    setup(onDelete);

    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);

    const spinner = await waitFor(() => {
      const svg = button.querySelector("svg");
      expect(svg?.getAttribute("class")).toContain("animate-spin");
      return svg;
    });
    expect(spinner).not.toBeNull();
    expect(button).toBeDisabled();

    settle();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("carries the code the server sends, not just the message", () => {
    expect(forcedRetryError("kept").code).toBe(WORKTREE_KEPT_CODE);
  });
});
