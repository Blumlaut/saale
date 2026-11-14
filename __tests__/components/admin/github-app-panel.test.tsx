// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { GithubAppPanel } from "@/components/admin/github-app-panel";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The panel reads one endpoint and renders whatever the app holds. */
function mockApp(app: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            app,
            publicUrl: "https://saale.example",
            callbackUrl: "https://saale.example/api/integrations/github/callback",
            setupUrl: "https://saale.example/api/integrations/github/installed",
            connectedAccounts: 1,
            installations: 1,
            tokenPrecedence: "app",
          }),
        }) as unknown as Response,
    ),
  );
}

const SAVED_APP = {
  appId: "4711",
  clientId: "client-abc",
  slug: "saale",
  name: "Saale",
  ownerLogin: "Juli04",
  enabled: true,
  updatedAt: "2026-11-13T20:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GithubAppPanel", () => {
  it("warns about the permissions the app was registered without", async () => {
    // The app asked for what an older Saale needed: everything but the
    // permission the repository picker takes, which is exactly the gap this
    // panel exists to name.
    mockApp({
      ...SAVED_APP,
      permissions: { contents: "write", pull_requests: "write" },
      missingPermissions: [
        {
          name: "installation_repositories",
          label: "GitHub App installation repository access",
          level: "write",
          why: "the repository picker adds and removes repositories",
        },
      ],
    });
    render(<GithubAppPanel />);

    expect(
      await screen.findByText("One permission Saale works with is missing."),
    ).toBeInTheDocument();
    expect(screen.getByText(/GitHub App installation repository access/)).toBeInTheDocument();
    expect(screen.getByText(/Read & write/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Every permission Saale works with is granted/),
    ).not.toBeInTheDocument();
  });

  it("says so in green when nothing is missing", async () => {
    mockApp({
      ...SAVED_APP,
      permissions: {
        contents: "write",
        pull_requests: "write",
        workflows: "write",
        checks: "read",
        metadata: "read",
        installation_repositories: "write",
      },
      missingPermissions: [],
    });
    render(<GithubAppPanel />);

    expect(
      await screen.findByText("Every permission Saale works with is granted."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/permission Saale works with is missing/)).not.toBeInTheDocument();
  });
});
