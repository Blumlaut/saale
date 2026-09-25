// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const mockFetchJson = vi.fn();
const mockPostJson = vi.fn();
const mockPatchJson = vi.fn();
const mockDeleteJson = vi.fn();

vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  postJson: (...args: unknown[]) => mockPostJson(...args),
  patchJson: (...args: unknown[]) => mockPatchJson(...args),
  deleteJson: (...args: unknown[]) => mockDeleteJson(...args),
}));

import { MachineNotesDialog } from "@/components/infra/machine-notes-dialog";
import type { InfraMachine } from "@/app/dashboard/infra/page";

const MACHINE: InfraMachine = {
  id: "m-1",
  name: "prod-web-01",
  host: "example.com",
  port: 22,
  username: "deploy",
  authMethod: "key",
  noteCount: 2,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const NOTE_A = {
  id: "n-1",
  title: "Nginx config",
  category: "paths",
  content: "/etc/nginx/nginx.conf",
  createdAt: "2025-01-02T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const NOTE_B = {
  id: "n-2",
  title: "Restart postgres",
  category: "quirks",
  content: "systemctl restart postgresql",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

function renderDialog(overrides: Partial<Parameters<typeof MachineNotesDialog>[0]> = {}) {
  const onSuccess = vi.fn();
  render(
    <MachineNotesDialog
      open
      onOpenChange={vi.fn()}
      machine={MACHINE}
      onSuccess={onSuccess}
      {...overrides}
    />,
  );
  return { onSuccess };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MachineNotesDialog", () => {
  it("lists the machine's notes after fetching", async () => {
    mockFetchJson.mockResolvedValue({ notes: [NOTE_A, NOTE_B] });

    renderDialog();

    await screen.findByText("Nginx config");
    expect(screen.getByText("Restart postgres")).toBeInTheDocument();
    expect(mockFetchJson).toHaveBeenCalledWith("/api/infra/machines/m-1/notes");
  });

  it("opens the editor with the note's values and saves edits via PATCH", async () => {
    mockFetchJson.mockResolvedValue({ notes: [NOTE_A] });
    mockPatchJson.mockResolvedValue({ note: { ...NOTE_A, title: "Nginx config v2" } });
    const { onSuccess } = renderDialog();

    const row = await screen.findByRole("button", { name: /Nginx config/ });
    fireEvent.click(row);

    const titleInput = screen.getByRole("textbox", { name: "Title" });
    const contentArea = screen.getByRole("textbox", { name: "Content" });
    expect(titleInput).toHaveValue("Nginx config");
    expect(contentArea).toHaveValue("/etc/nginx/nginx.conf");

    fireEvent.change(titleInput, { target: { value: "Nginx config v2" } });
    const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
    fireEvent.submit(form);

    expect(mockPatchJson).toHaveBeenCalledWith("/api/infra/machines/m-1/notes/n-1", {
      title: "Nginx config v2",
      content: "/etc/nginx/nginx.conf",
      category: "paths",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("creates a new note via POST with the default category", async () => {
    mockFetchJson.mockResolvedValue({ notes: [NOTE_A] });
    mockPostJson.mockResolvedValue({
      note: {
        id: "n-3",
        title: "Backup cron",
        category: "services",
        content: "0 2 * * * restic",
        createdAt: "2025-01-03T00:00:00.000Z",
      },
    });
    const { onSuccess } = renderDialog();

    await screen.findByText("Nginx config");
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Backup cron" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "0 2 * * * restic" },
    });

    const form = screen.getByRole("button", { name: "Create Note" }).closest("form")!;
    fireEvent.submit(form);

    expect(mockPostJson).toHaveBeenCalledWith("/api/infra/machines/m-1/notes", {
      title: "Backup cron",
      content: "0 2 * * * restic",
      category: "general",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("deletes a note after confirmation and refreshes the list", async () => {
    // First fetch returns the note, second (after delete) returns none
    mockFetchJson.mockResolvedValueOnce({ notes: [NOTE_A] }).mockResolvedValueOnce({ notes: [] });
    mockDeleteJson.mockResolvedValue({ deleted: true, id: NOTE_A.id });
    const { onSuccess } = renderDialog();

    const row = await screen.findByRole("button", { name: /Nginx config/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Confirm inside the alert dialog
    const alert = await screen.findByRole("alertdialog");
    const confirmButton = within(alert).getByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    expect(mockDeleteJson).toHaveBeenCalledWith("/api/infra/machines/m-1/notes/n-1");
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    await screen.findByText(/No notes yet/);
  });

  it("cancelling the delete dialog does not delete", async () => {
    mockFetchJson.mockResolvedValue({ notes: [NOTE_A] });
    renderDialog();

    const row = await screen.findByRole("button", { name: /Nginx config/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alertdialog");
    fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));

    expect(mockDeleteJson).not.toHaveBeenCalled();
    // The note is still editable in the background
    expect(screen.getByRole("textbox", { name: "Content" })).toHaveValue(NOTE_A.content);
  });

  it("shows an error with retry when the fetch fails", async () => {
    mockFetchJson.mockRejectedValueOnce(new Error("network down")).mockResolvedValue({
      notes: [NOTE_A],
    });

    renderDialog();

    expect(await screen.findByText("network down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Nginx config")).toBeInTheDocument();
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });
});
