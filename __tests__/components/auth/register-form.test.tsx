// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RegisterForm } from "@/app/auth/register/register-form";
import { authClient } from "@/lib/auth-client";
import { fetchJson } from "@/lib/http";
import { USERNAME_RULES } from "@/lib/auth/username";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/http", () => ({ fetchJson: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signUp: { email: vi.fn() },
    signIn: { social: vi.fn() },
  },
}));

const signUpEmail = vi.mocked(authClient.signUp.email);
const signInSocial = vi.mocked(authClient.signIn.social);

const telegramOn = { telegram: { enabled: true } };
const telegramOff = { telegram: { enabled: false } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchJson).mockResolvedValue({ enabled: true });
});

async function renderForm(props: { telegram: { enabled: boolean } } = telegramOff) {
  render(<RegisterForm {...props} />);
  return screen.findByLabelText("Username");
}

function fill({
  username,
  email = "ada@example.com",
  password = "correct horse",
  confirmPassword = password,
}: {
  username: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: confirmPassword },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("sign-up form", () => {
  it("asks for a username instead of a full name", async () => {
    await renderForm();

    // The handle is the identity: one identifier field, hinted for managers.
    expect(screen.getByLabelText("Username")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Username")).toHaveAttribute("name", "username");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByText(USERNAME_RULES)).toBeInTheDocument();
  });

  it("registers the normalized handle, keeping the typed casing as display name", async () => {
    signUpEmail.mockResolvedValue({ data: null, error: null } as never);
    await renderForm();

    fill({ username: "Ada.Lovelace" });

    await waitFor(() =>
      expect(signUpEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Ada.Lovelace",
          username: "ada.lovelace",
          email: "ada@example.com",
          password: "correct horse",
        }),
      ),
    );
  });

  it("rejects a username outside the allowed character set before calling the API", async () => {
    await renderForm();

    fill({ username: "ada lovelace" });

    expect(await screen.findByText(/does not fit/i)).toBeInTheDocument();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("flags an invalid handle as the user types it", async () => {
    await renderForm();

    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("aria-invalid", "false");

    fireEvent.change(input, { target: { value: "ada@example.com" } });

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(USERNAME_RULES)).toHaveClass("text-destructive");
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("still refuses mismatched passwords", async () => {
    await renderForm();

    fill({ username: "ada.lovelace", password: "correct horse", confirmPassword: "other horse" });

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("offers a Telegram sign-up here, where an account may be created", async () => {
    signInSocial.mockResolvedValue({ data: null, error: null } as never);
    await renderForm(telegramOn);

    fireEvent.click(screen.getByRole("button", { name: "Sign up with Telegram" }));

    // The login page's button must not carry this: creating the account is the
    // difference between a sign-up and a sign-in.
    await waitFor(() =>
      expect(signInSocial).toHaveBeenCalledWith({
        provider: "telegram-oidc",
        requestSignUp: true,
        callbackURL: "/dashboard/chat",
        errorCallbackURL: "/auth/login",
      }),
    );
  });

  it("offers no Telegram sign-up on an instance without it", async () => {
    await renderForm(telegramOff);

    expect(screen.queryByRole("button", { name: /Telegram/ })).not.toBeInTheDocument();
  });

  it("reports a Telegram sign-up that cannot be started", async () => {
    signInSocial.mockResolvedValue({
      data: null,
      error: { message: "Sign-ups are disabled" },
    } as never);
    await renderForm(telegramOn);

    fireEvent.click(screen.getByRole("button", { name: "Sign up with Telegram" }));

    expect(await screen.findByText("Sign-ups are disabled")).toBeInTheDocument();
  });
});
