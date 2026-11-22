// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/**
 * The one confirmation behind a delete that leaves nothing to explain.
 *
 * A caller hands it a title, a description and the delete itself: the box
 * closes on success and stays open on a throw.
 */

function setup(onConfirm: () => Promise<void>, onOpenChange = vi.fn()) {
  render(
    <ConfirmDialog
      open
      title="Delete the RAG sync job?"
      description="Its schedule stops and the run history goes with it."
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConfirmDialog", () => {
  it("shows what is being deleted and closes once it lands", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = setup(onConfirm);

    expect(screen.getByText("Delete the RAG sync job?")).toBeInTheDocument();
    expect(screen.getByText(/the run history goes with it/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing until the click that confirms it", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = setup(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the box open with the reason when the delete fails", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("That role is still in use."));
    const { onOpenChange } = setup(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("That role is still in use.")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("names the action and the wait for it", async () => {
    let settle = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(
      <ConfirmDialog
        open
        title="Unlink Anthropic?"
        description="Its key is deleted."
        confirmLabel="Unlink"
        busyLabel="Unlinking…"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));

    const busy = await screen.findByRole("button", { name: "Unlinking…" });
    expect(busy).toBeDisabled();

    settle();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink" })).toBeEnabled());
  });

  it("drops the last error when it reopens", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("The directory was not removed."));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Delete the checkout?"
        description="No account owns it."
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("The directory was not removed.");

    rerender(
      <ConfirmDialog
        open={false}
        title="Delete the checkout?"
        description="No account owns it."
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <ConfirmDialog
        open
        title="Delete the checkout?"
        description="No account owns it."
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByText("The directory was not removed.")).not.toBeInTheDocument();
  });
});
