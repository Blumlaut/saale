// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";

const { stopImpersonating } = vi.hoisted(() => ({ stopImpersonating: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { admin: { stopImpersonating } },
}));

/** Where the full page load went, since jsdom cannot navigate. */
function stubLocation() {
  const location = { href: "" } as Location;
  Object.defineProperty(window, "location", { configurable: true, value: location });
  return location;
}

function mockSessionFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: "u1", name: "Test User", email: "test@example.com", role: "user" },
            session: { impersonatedBy: "admin1" },
          }),
          { status: 200 },
        ),
    ),
  );
}

async function stop() {
  render(<ImpersonationBanner />);
  const button = await screen.findByRole("button", { name: /stop impersonating/i });
  fireEvent.click(button);
  return button;
}

let location: Location;

beforeEach(() => {
  stopImpersonating.mockReset();
  mockSessionFetch();
  location = stubLocation();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImpersonationBanner", () => {
  it("returns to the admin panel with a full page load", async () => {
    stopImpersonating.mockResolvedValue({ data: {}, error: null });

    await stop();

    await waitFor(() => expect(location.href).toBe("/admin/users"));
  });

  it("stays on the page when stopping fails", async () => {
    stopImpersonating.mockResolvedValue({ data: null, error: { message: "nope" } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const button = await stop();

    await waitFor(() => expect(button).toBeEnabled());
    expect(location.href).toBe("");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
