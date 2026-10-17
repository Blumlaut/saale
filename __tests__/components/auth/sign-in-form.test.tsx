// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LoginForm } from "@/app/auth/login/login-form";
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
  authClient: {
    signIn: { email: vi.fn(), username: vi.fn(), social: vi.fn() },
    twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
  },
}));

const signInUsername = vi.mocked(authClient.signIn.username);
const signInEmail = vi.mocked(authClient.signIn.email);
const signInSocial = vi.mocked(authClient.signIn.social);

const telegramOff = { telegram: { enabled: false }, signupsEnabled: true };
const telegramOn = { telegram: { enabled: true }, signupsEnabled: true };
const signupsClosed = { telegram: { enabled: true }, signupsEnabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  query.current = new URLSearchParams();
});

function submitCredentials(identifier: string, password = "correct horse") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in form", () => {
  it("marks the identifier and password so password managers see both fields", () => {
    render(<LoginForm {...telegramOff} />);

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
    render(<LoginForm {...telegramOff} />);

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
    render(<LoginForm {...telegramOff} />);

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
    render(<LoginForm {...telegramOff} />);

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
    render(<LoginForm {...telegramOff} />);

    submitCredentials("ada.lovelace");

    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("asks for a two-factor code after a password-only sign-in", async () => {
    signInUsername.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null } as never);
    render(<LoginForm {...telegramOff} />);

    submitCredentials("ada.lovelace");

    expect(await screen.findByLabelText("Authenticator code")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("hands the browser to Telegram when that sign-in is offered", async () => {
    signInSocial.mockResolvedValue({ data: null, error: null } as never);
    render(<LoginForm {...telegramOn} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Telegram" }));

    await waitFor(() =>
      expect(signInSocial).toHaveBeenCalledWith({
        provider: "telegram-oidc",
        callbackURL: "/dashboard/chat",
        errorCallbackURL: "/auth/login",
      }),
    );
    // Signing in must not ask better-auth to create the account it cannot find.
    expect(vi.mocked(signInSocial).mock.calls[0]?.[0]).not.toHaveProperty("requestSignUp");
  });

  it("offers no Telegram button on an instance without it", () => {
    render(<LoginForm {...telegramOff} />);

    expect(screen.queryByRole("button", { name: /Telegram/ })).not.toBeInTheDocument();
  });

  it("explains a Telegram failure the callback sent back", () => {
    query.current = new URLSearchParams({ error: "account_not_linked" });
    render(<LoginForm {...telegramOn} />);

    expect(screen.getByText(/not linked to a Saale account/)).toBeInTheDocument();
  });

  it("sends an unlinked Telegram login to the register page, not to a new account", () => {
    query.current = new URLSearchParams({ error: "signup_disabled" });
    render(<LoginForm {...telegramOn} />);

    expect(screen.getByText(/Sign up with Telegram to create one/)).toBeInTheDocument();
  });

  it("says sign-ups are shut when the unlinked login has nowhere to go", () => {
    query.current = new URLSearchParams({ error: "signup_disabled" });
    render(<LoginForm {...signupsClosed} />);

    expect(screen.getByText(/sign-ups are not open/)).toBeInTheDocument();
  });

  it("shows the error message when Telegram cannot be started", async () => {
    signInSocial.mockResolvedValue({
      data: null,
      error: { message: "Provider not found" },
    } as never);
    render(<LoginForm {...telegramOn} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Telegram" }));

    expect(await screen.findByText("Provider not found")).toBeInTheDocument();
  });
});
