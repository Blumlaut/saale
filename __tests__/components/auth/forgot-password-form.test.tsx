// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForgotPasswordForm } from "@/app/auth/forgot-password/forgot-password-form";
import { authClient } from "@/lib/auth-client";

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), refresh: vi.fn() } }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { requestPasswordReset: vi.fn() },
}));

const requestReset = vi.mocked(authClient.requestPasswordReset);

beforeEach(() => {
  vi.clearAllMocks();
});

function askForLink(email = "ada@example.com") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
}

describe("forgot password form", () => {
  it("asks for a link that lands on the page that sets a password", async () => {
    requestReset.mockResolvedValue({ data: { status: true }, error: null });
    render(<ForgotPasswordForm mailConfigured />);

    askForLink("ada@example.com");

    await waitFor(() =>
      expect(requestReset).toHaveBeenCalledWith({
        email: "ada@example.com",
        redirectTo: "/auth/reset-password",
      }),
    );
  });

  it("answers the same way whether or not the address has an account", async () => {
    requestReset.mockResolvedValue({ data: { status: true }, error: null });
    render(<ForgotPasswordForm mailConfigured />);

    askForLink("nobody@example.com");

    // The endpoint answers the same for an unknown address, so this page must not say more.
    expect(await screen.findByText(/if that address has an account here/i)).toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });

  it("says the instance cannot send when it has no relay", () => {
    render(<ForgotPasswordForm mailConfigured={false} />);

    expect(screen.getByText(/no mail server set up/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows what the endpoint said when the request fails", async () => {
    requestReset.mockResolvedValue({
      data: null,
      error: { message: "Invalid email", status: 400, statusText: "BAD_REQUEST" },
    });
    render(<ForgotPasswordForm mailConfigured />);

    askForLink();

    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
  });
});
