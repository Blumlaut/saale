// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockPostJson = vi.fn();
const mockPatchJson = vi.fn();
vi.mock("@/lib/http", () => ({
  postJson: (...args: unknown[]) => mockPostJson(...args),
  patchJson: (...args: unknown[]) => mockPatchJson(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { AccountSheet } from "@/components/mail/account-sheet";

/** Type into a controlled input the way a person does: one character at a time. */
function type(input: HTMLInputElement, text: string) {
  for (const char of text) {
    fireEvent.change(input, { target: { value: input.value + char } });
  }
}

/** Fill the email field, then wait for the debounced autodiscover request. */
async function fillEmail(address: string, { replace = false } = {}) {
  const email = screen.getByPlaceholderText("you@example.com") as HTMLInputElement;
  const callsBefore = mockPostJson.mock.calls.length;
  if (replace) {
    fireEvent.change(email, { target: { value: address } });
  } else {
    type(email, address);
  }
  await waitFor(() => expect(mockPostJson.mock.calls.length).toBeGreaterThan(callsBefore), {
    timeout: 3_000,
  });
  return email;
}

function autodiscoverResponse(imap: unknown, smtp: unknown, source: "srv" | "probe" | null) {
  return { imap, smtp, source };
}

function renderSheet(props: Partial<Parameters<typeof AccountSheet>[0]> = {}) {
  render(<AccountSheet open onOpenChange={vi.fn()} onSuccess={vi.fn()} {...props} />);
  return {
    imapHost: () => screen.getByPlaceholderText("imap.example.com") as HTMLInputElement,
    smtpHost: () => screen.getByPlaceholderText("smtp.example.com") as HTMLInputElement,
    password: () => screen.getByPlaceholderText("••••••••") as HTMLInputElement,
  };
}

describe("AccountSheet server detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with empty host fields instead of another provider's servers", () => {
    const { imapHost, smtpHost } = renderSheet();

    // Prefilled hosts used to point every new account at imap.gmail.com.
    expect(imapHost().value).toBe("");
    expect(smtpHost().value).toBe("");
  });

  it("leaves both hosts empty and asks for manual input when nothing is found", async () => {
    mockPostJson.mockResolvedValue(autodiscoverResponse(null, null, null));
    const { imapHost, smtpHost } = renderSheet();

    await fillEmail("esthrw1@proton.me");
    await screen.findByText(/No IMAP\/SMTP server found for proton\.me/);

    expect(imapHost().value).toBe("");
    expect(smtpHost().value).toBe("");
    // The settings stay open — nothing was detected, so nothing may look "done".
    expect(screen.queryByRole("button", { name: /Edit server settings/ })).toBeNull();
  });

  it("keeps the settings open and names the missing half on a partial result", async () => {
    mockPostJson.mockResolvedValue(
      autodiscoverResponse(null, { host: "smtp.protonmail.ch", port: 465, secure: true }, "probe"),
    );
    const { imapHost, smtpHost } = renderSheet();

    await fillEmail("esthrw1@proton.me");
    await screen.findByText(/IMAP settings not detected/);

    expect(imapHost().value).toBe("");
    expect(smtpHost().value).toBe("smtp.protonmail.ch");
    // A half-filled pair must never be presented as a detected configuration.
    expect(screen.queryByText(/settings filled in/)).toBeNull();
  });

  it("fills both servers and collapses the settings once both are detected", async () => {
    mockPostJson.mockResolvedValue(
      autodiscoverResponse(
        { host: "imap.fastmail.com", port: 993, secure: true },
        { host: "smtp.fastmail.com", port: 465, secure: true },
        "srv",
      ),
    );
    renderSheet();

    await fillEmail("user@fastmail.com");
    await screen.findByText(/Detected via DNS — settings filled in/);

    expect(screen.getByRole("button", { name: /Edit server settings/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Edit server settings/ }));
    expect((screen.getByPlaceholderText("imap.example.com") as HTMLInputElement).value).toBe(
      "imap.fastmail.com",
    );
    expect((screen.getByPlaceholderText("smtp.example.com") as HTMLInputElement).value).toBe(
      "smtp.fastmail.com",
    );
  });

  it("treats a failed lookup as 'enter it yourself', not as success", async () => {
    mockPostJson.mockRejectedValue(new Error("502 Bad Gateway"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderSheet();

      await fillEmail("user@example.com");
      await screen.findByText(/Settings lookup failed/);

      expect(consoleError).toHaveBeenCalled();
      expect(screen.queryByText(/settings filled in/)).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ignores a slow answer for a superseded address", async () => {
    const pending: Array<{
      address: string;
      resolve: (value: unknown) => void;
    }> = [];
    mockPostJson.mockImplementation(
      (_url: string, body: { email: string }) =>
        new Promise((resolve) => pending.push({ address: body.email, resolve })),
    );

    const { imapHost, smtpHost } = renderSheet();
    await fillEmail("first@slow.example");
    await fillEmail("second@fast.example", { replace: true });

    // The lookup for the second address comes back first, with a partial result
    // (so the settings stay on screen and can be inspected)…
    const second = pending.find((p) => p.address === "second@fast.example")!;
    second.resolve(
      autodiscoverResponse({ host: "imap.fast.example", port: 993, secure: true }, null, "probe"),
    );
    await waitFor(() => expect(imapHost().value).toBe("imap.fast.example"));

    // …and the stale answer for the address the user edited away must not win.
    const first = pending.find((p) => p.address === "first@slow.example")!;
    first.resolve(
      autodiscoverResponse(
        { host: "imap.slow.example", port: 993, secure: true },
        { host: "smtp.slow.example", port: 465, secure: true },
        "probe",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(imapHost().value).toBe("imap.fast.example");
    expect(smtpHost().value).toBe("");
  });

  it("will not save until both hosts are known", async () => {
    mockPostJson.mockResolvedValue(autodiscoverResponse(null, null, null));
    const { password } = renderSheet();

    await fillEmail("user@example.com");
    type(password(), "app-password");

    const save = screen.getByRole("button", { name: "Save Account" });
    expect(save).toBeDisabled();

    type(screen.getByPlaceholderText("imap.example.com"), "imap.example.com");
    type(screen.getByPlaceholderText("smtp.example.com"), "smtp.example.com");
    expect(save).toBeEnabled();
  });

  it("reports a failed first sync after saving", async () => {
    mockPostJson.mockImplementation((url: string) => {
      if (url === "/api/email/autodiscover") {
        return Promise.resolve(autodiscoverResponse(null, null, null));
      }
      return Promise.resolve({
        account: { id: "acc-1" },
        sync: { newMessages: 0, updatedMessages: 0, errors: ["Connection error: Invalid login"] },
      });
    });
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    renderSheet({ onSuccess, onOpenChange });

    await fillEmail("user@example.com");
    type(screen.getByPlaceholderText("••••••••"), "app-password");
    type(screen.getByPlaceholderText("imap.example.com"), "imap.example.com");
    type(screen.getByPlaceholderText("smtp.example.com"), "smtp.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Save Account" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      "Account saved, but the first sync failed",
      expect.objectContaining({ description: expect.stringContaining("Invalid login") }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
