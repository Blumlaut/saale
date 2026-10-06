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
    signIn: { email: vi.fn(), username: vi.fn() },
    twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
  },
}));

const signInUsername = vi.mocked(authClient.signIn.username);
const signInEmail = vi.mocked(authClient.signIn.email);

beforeEach(() => vi.clearAllMocks());

function submitCredentials(identifier: string, password = "correct horse") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in form", () => {
  it("marks the identifier and password so password managers see both fields", () => {
    render(<LoginPage />);

    const identifier = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");

    // Mobile password managers only offer to fill a form whose identifier is
    // hinted as `username` — `email` marks contact data and hides the password.
    expect(identifier).toHaveAttribute("autocomplete", "username");
    expect(identifier).toHaveAttribute("name", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("name", "password");

    // Both belong to the one submittable form the managers scan.
    const form = password.closest("form");
    expect(form).not.toBeNull();
    expect(form).toContainElement(identifier);
    expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it("signs in with a username", async () => {
    signInUsername.mockResolvedValue({ data: null, error: null } as never);
    render(<LoginPage />);

    submitCredentials("ada.lovelace");

    await waitFor(() =>
      expect(signInUsername).toHaveBeenCalledWith(
        expect.objectContaining({ username: "ada.lovelace", password: "correct horse" }),
      ),
    );
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("routes an email address to email sign-in", async () => {
    signInEmail.mockResolvedValue({ data: null, error: null } as never);
    render(<LoginPage />);

    submitCredentials("ada@example.com");

    await waitFor(() =>
      expect(signInEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "ada@example.com", password: "correct horse" }),
      ),
    );
    expect(signInUsername).not.toHaveBeenCalled();
  });

  it("trims the identifier before routing it", async () => {
    signInUsername.mockResolvedValue({ data: null, error: null } as never);
    render(<LoginPage />);

    submitCredentials("  ada.lovelace  ");

    await waitFor(() =>
      expect(signInUsername).toHaveBeenCalledWith(
        expect.objectContaining({ username: "ada.lovelace" }),
      ),
    );
  });

  it("shows the server's error message and stays put", async () => {
    signInUsername.mockResolvedValue({
      data: null,
      error: { message: "Invalid username or password" },
    } as never);
    render(<LoginPage />);

    submitCredentials("ada.lovelace");

    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("asks for a two-factor code after a password-only sign-in", async () => {
    signInUsername.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null } as never);
    render(<LoginPage />);

    submitCredentials("ada.lovelace");

    expect(await screen.findByLabelText("Authenticator code")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});
