// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockFetchJson = vi.fn();
const mockPostJson = vi.fn();
vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  postJson: (...args: unknown[]) => mockPostJson(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { ComposeSheet } from "@/components/mail/compose-sheet";

const accounts = [
  { id: "acc-1", name: "Work", email: "work@example.com", enabled: true },
  { id: "acc-2", name: "Home", email: "home@example.com", enabled: true },
];

function renderSheet() {
  const onOpenChange = vi.fn();
  render(<ComposeSheet open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

/** Fill the fields ComposeSheet sends: a recipient, a subject and a body. */
function fillDraft() {
  fireEvent.change(screen.getByPlaceholderText("Name or email"), {
    target: { value: "ada@example.com, bob@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText("Email subject"), { target: { value: "Hello" } });
  fireEvent.change(screen.getByPlaceholderText("Write your message..."), {
    target: { value: "Body text" },
  });
}

describe("ComposeSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchJson.mockImplementation(async (url: string) =>
      url.includes("/api/email/accounts")
        ? { accounts }
        : url.includes("/api/contacts/recent")
          ? { recipients: [] }
          : { contacts: [] },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the draft from the account the sheet loaded", async () => {
    mockPostJson.mockResolvedValue({ sentFolder: "Sent" });
    const { onOpenChange } = renderSheet();

    await waitFor(() => expect(screen.getByPlaceholderText("Email subject")).toBeInTheDocument());
    fillDraft();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send/i }));
    });

    expect(mockPostJson).toHaveBeenCalledWith("/api/email/accounts/acc-1/send", {
      to: ["ada@example.com", "bob@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Body text",
    });
    expect(toast.success).toHaveBeenCalledWith("Email sent");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("warns when the sent copy could not be filed, and still closes", async () => {
    mockPostJson.mockResolvedValue({ sentFolder: null });
    const { onOpenChange } = renderSheet();

    await waitFor(() => expect(screen.getByPlaceholderText("Email subject")).toBeInTheDocument());
    fillDraft();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send/i }));
    });

    expect(toast.warning).toHaveBeenCalledWith("Email sent, but no copy could be filed in Sent");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the sheet open with the message when the send fails", async () => {
    mockPostJson.mockRejectedValue(new Error("SMTP refused the connection"));
    const { onOpenChange } = renderSheet();

    await waitFor(() => expect(screen.getByPlaceholderText("Email subject")).toBeInTheDocument());
    fillDraft();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send/i }));
    });

    expect(screen.getByText("SMTP refused the connection")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("logs a failed account load instead of hiding it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchJson.mockRejectedValue(new Error("offline"));

    renderSheet();

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(mockPostJson).not.toHaveBeenCalled();
  });
});
