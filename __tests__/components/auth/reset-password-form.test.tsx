// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ResetPasswordForm } from "@/app/auth/reset-password/reset-password-form";
import { authClient } from "@/lib/auth-client";

const { router, query } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
  query: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => query.current,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { resetPassword: vi.fn() },
}));

const resetPassword = vi.mocked(authClient.resetPassword);

beforeEach(() => {
  vi.clearAllMocks();
  query.current = new URLSearchParams("token=abc123");
  resetPassword.mockResolvedValue({ data: { status: true }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

function fill(password: string, confirmPassword = password) {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Repeat it"), { target: { value: confirmPassword } });
  fireEvent.click(screen.getByRole("button", { name: "Set the password" }));
}

describe("reset password form", () => {
  it("sets the password against the token from the link", async () => {
    render(<ResetPasswordForm minPasswordLength={8} />);

    fill("correct horse battery", "correct horse battery");

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith({
        newPassword: "correct horse battery",
        token: "abc123",
      }),
    );
  });

  it("refuses a password shorter than the instance allows, without asking", async () => {
    render(<ResetPasswordForm minPasswordLength={16} />);

    expect(screen.getByText("At least 16 characters")).toBeInTheDocument();
    fill("twelve chars", "twelve chars");

    expect(await screen.findByText(/needs at least 16 characters/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("refuses two passwords that differ", async () => {
    render(<ResetPasswordForm minPasswordLength={8} />);

    fill("correct horse", "correct horsey");

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("says the link is spent when it arrives with an error", () => {
    query.current = new URLSearchParams("error=INVALID_TOKEN");
    render(<ResetPasswordForm minPasswordLength={8} />);

    expect(screen.getByText(/expired or has already been used/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("says the link is spent when it arrives with no token at all", () => {
    query.current = new URLSearchParams();
    render(<ResetPasswordForm minPasswordLength={8} />);

    expect(screen.getByText(/expired or has already been used/i)).toBeInTheDocument();
  });

  it("sends the reader to sign in once the password is changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ResetPasswordForm minPasswordLength={8} />);

    fill("correct horse", "correct horse");

    expect(await screen.findByText(/your password is changed/i)).toBeInTheDocument();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/auth/login"), { timeout: 3000 });
  });
});
