// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginPage from "@/app/auth/login/page";
import { authClient } from "@/lib/auth-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: vi.fn() },
    twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
  },
}));

const signInEmail = vi.mocked(authClient.signIn.email);

beforeEach(() => vi.clearAllMocks());

describe("sign-in form", () => {
  it("marks the identifier and password so password managers see both fields", () => {
    render(<LoginPage />);

    const identifier = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    // Mobile password managers only offer to fill a form whose identifier is
    // hinted as `username` — `email` marks contact data and hides the password.
    expect(identifier).toHaveAttribute("autocomplete", "username");
    expect(identifier).toHaveAttribute("name", "email");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("name", "password");

    // Both belong to the one submittable form the managers scan.
    const form = password.closest("form");
    expect(form).not.toBeNull();
    expect(form).toContainElement(identifier);
    expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it("signs in with the values a password manager filled", async () => {
    signInEmail.mockResolvedValue({ data: null, error: null } as never);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(signInEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "ada@example.com", password: "correct horse" }),
      ),
    );
  });

  it("asks for a two-factor code after a password-only sign-in", async () => {
    signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null } as never);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByLabelText("Authenticator code")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});
