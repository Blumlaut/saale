// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { GithubCard } from "@/components/integrations/github-card";
import type { GithubAppSection, GithubStatus } from "@/lib/integrations/github";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** An instance whose admin saved a GitHub App this account has not authorized. */
const appConfigured: GithubAppSection = {
  configured: true,
  slug: "saale",
  name: "Saale",
  permissions: null,
  authorized: null,
  installations: [],
  pending: null,
};

const appAuthorized: GithubAppSection = {
  ...appConfigured,
  authorized: { login: "octocat", expiresAt: null },
  installations: [
    {
      installationId: "42",
      accountLogin: "octocat",
      accountType: "User",
      repositorySelection: "all",
      repositories: null,
      suspended: false,
    },
  ],
};

/** A login gh keeps in its own config, which is what a command would use. */
const cliLogin: GithubStatus = {
  credential: {
    host: "github.com",
    login: "octocat",
    scopes: null,
    gitProtocol: null,
    source: "/home/saale/.config/gh/hosts.yml",
  },
  pending: null,
  error: null,
};

const noCredential: GithubStatus = { credential: null, pending: null, error: null };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The card reads one endpoint; every other call is a bug in the test. */
function mockStatus(app: GithubAppSection, cli: GithubStatus) {
  const fetchMock = vi.fn(
    async () =>
      ({ ok: true, status: 200, json: async () => ({ app, cli }) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GithubCard", () => {
  it("offers the connect button when nothing is connected", async () => {
    mockStatus(appConfigured, noCredential);
    render(<GithubCard />);

    expect(await screen.findByRole("button", { name: /Connect GitHub/ })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Authorize the app/ })).not.toBeInTheDocument();
  });

  it("shows the app login once the app is authorized", async () => {
    mockStatus(appAuthorized, noCredential);
    render(<GithubCard />);

    expect(await screen.findByText("Signed in as @octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).not.toBeInTheDocument();
  });

  it("shows a CLI login under an app that is not authorized, not a connect button", async () => {
    // An instance with an app, an account signed in through gh: the workspace is
    // connected, so the box has to say by whom instead of offering to connect.
    mockStatus(appConfigured, cliLogin);
    render(<GithubCard />);

    expect(await screen.findByText("Signed in as @octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("gh and git use this login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Authorize the app/ })).toBeInTheDocument();
  });

  it("shows a CLI login without the app hint when the instance has no app", async () => {
    mockStatus({ ...appConfigured, configured: false, slug: null, name: null }, cliLogin);
    render(<GithubCard />);

    expect(await screen.findByText("Signed in as @octocat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Authorize the app/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).not.toBeInTheDocument();
  });
});
