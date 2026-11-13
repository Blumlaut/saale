// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

/** Authorized, but installed nowhere: step 2 of the setup assistant. */
const appAuthorizedNoInstall: GithubAppSection = { ...appAuthorized, installations: [] };

/** One installation narrowed to two repositories by hand. */
const appNarrowed: GithubAppSection = {
  ...appAuthorized,
  installations: [
    {
      installationId: "42",
      accountLogin: "octocat",
      accountType: "User",
      repositorySelection: "selected",
      repositories: ["saale", "site"],
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

/** The same account, but gh took the token from `GH_TOKEN` rather than its config. */
const cliVariableToken: GithubStatus = {
  credential: {
    host: "github.com",
    login: "octocat",
    scopes: null,
    gitProtocol: null,
    source: "GH_TOKEN",
  },
  pending: null,
  error: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The card reads one endpoint; every other call is a bug in the test.
 *
 * `onConnect` is what a POST answers, so a test can follow a sign-in from the
 * card into the setup dialog.
 */
function mockStatus(
  app: GithubAppSection,
  cli: GithubStatus,
  onConnect?: { app: GithubAppSection; cli: GithubStatus },
) {
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: async () => (init?.method === "POST" && onConnect ? onConnect : { app, cli }),
      }) as unknown as Response,
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

  it("names a gh login beside the app's own", async () => {
    mockStatus(appAuthorized, cliLogin);
    render(<GithubCard />);

    expect(
      await screen.findByText("The GitHub CLI is also signed in as @octocat."),
    ).toBeInTheDocument();
  });

  it("does not call a token from the environment a CLI login", async () => {
    // What the workspace reports is what a command *would use*: while the app is
    // the source Saale's gh shim hands it our token, and a GH_TOKEN variable wins
    // too. Both read as a token from the environment, and neither is a login.
    mockStatus(appAuthorized, cliVariableToken);
    render(<GithubCard />);

    expect(await screen.findByText("Signed in as @octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/The GitHub CLI is also signed in/)).not.toBeInTheDocument();
  });

  it("words an environment token as a variable when it is the only credential", async () => {
    mockStatus(appConfigured, cliVariableToken);
    render(<GithubCard />);

    expect(
      await screen.findByText("gh and git use GH_TOKEN from your environment variables"),
    ).toBeInTheDocument();
  });

  it("shows a CLI login without the app hint when the instance has no app", async () => {
    mockStatus({ ...appConfigured, configured: false, slug: null, name: null }, cliLogin);
    render(<GithubCard />);

    expect(await screen.findByText("Signed in as @octocat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Authorize the app/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).not.toBeInTheDocument();
  });

  it("shows the device code in the setup dialog while a CLI login exists", async () => {
    // The dead end this guards: step 1 called a CLI login "signed in", hid the
    // code, and never advanced, so the dialog offered nothing but Close.
    mockStatus(appConfigured, cliLogin, {
      app: {
        ...appConfigured,
        pending: {
          userCode: "1B47-ABE8",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2030-01-01T00:15:00.000Z",
        },
      },
      cli: cliLogin,
    });
    render(<GithubCard />);

    fireEvent.click(await screen.findByRole("button", { name: /Authorize the app/ }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("1B47-ABE8")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Signed in as @octocat/)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /Install on GitHub/ }),
    ).not.toBeInTheDocument();
  });

  it("moves on to the install step once the app is authorized", async () => {
    mockStatus(appConfigured, noCredential, { app: appAuthorizedNoInstall, cli: noCredential });
    render(<GithubCard />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect GitHub/ }));

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("button", { name: /Install on GitHub/ }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Install Saale on the account/)).toBeInTheDocument();
  });

  it("keeps GitHub's own page and Saale's picker apart as two actions", async () => {
    // Both change which repositories the installation covers, but only GitHub's
    // page installs, uninstalls and switches the all/selected mode. The box used
    // to offer them as "Manage repositories" and a bare count, which read as the
    // same thing (and as a status line rather than a button).
    mockStatus(appNarrowed, noCredential);
    render(<GithubCard />);

    const github = await screen.findByRole("link", { name: /Install \/ manage on GitHub/ });
    expect(github).toHaveAttribute("href", "https://github.com/settings/installations/42");

    expect(
      screen.getByRole("button", { name: "Repositories for octocat: 2 repositories" }),
    ).toBeInTheDocument();
  });

  it("says the app may not change its installations rather than offering a save", async () => {
    // An app registered before `installation_repositories` existed: the set can
    // be read and not written, so a Save button here would only produce a 403.
    const choices = {
      installationId: "42",
      accountLogin: "octocat",
      accountType: "User",
      selection: "selected",
      canManage: true,
      appCanManage: false,
      installed: [{ id: "10", name: "saale", fullName: "octocat/saale" }],
      candidates: [{ id: "10", fullName: "octocat/saale", installed: true }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          ({
            ok: true,
            status: 200,
            json: async () =>
              url.includes("/github/repositories")
                ? choices
                : { app: appNarrowed, cli: noCredential },
          }) as unknown as Response,
      ),
    );
    render(<GithubCard />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Repositories for octocat: 2 repositories" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("The app may not change its own installations."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/registered without the “GitHub App installation/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Manage on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/installations/42",
    );
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("names the permissions an app was registered without", async () => {
    // Everything Saale works with except the one the picker's calls take.
    mockStatus(
      {
        ...appConfigured,
        permissions: {
          contents: "write",
          pull_requests: "write",
          workflows: "write",
          checks: "read",
          metadata: "read",
        },
      },
      noCredential,
    );
    render(<GithubCard />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect GitHub/ }));

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("One permission Saale works with is missing."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/the repository picker adds and removes repositories/),
    ).toBeInTheDocument();
  });

  it("opens Saale's picker from the row and says it is the installation's own set", async () => {
    const choices = {
      installationId: "42",
      accountLogin: "octocat",
      accountType: "User",
      selection: "selected",
      canManage: true,
      appCanManage: true,
      installed: [
        { id: "10", name: "saale", fullName: "octocat/saale" },
        { id: "11", name: "site", fullName: "octocat/site" },
      ],
      candidates: [
        { id: "10", fullName: "octocat/saale", installed: true },
        { id: "12", fullName: "octocat/docs", installed: false },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          ({
            ok: true,
            status: 200,
            json: async () =>
              url.includes("/github/repositories")
                ? choices
                : { app: appNarrowed, cli: noCredential },
          }) as unknown as Response,
      ),
    );
    render(<GithubCard />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Repositories for octocat: 2 repositories" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/the same set as “Only select repositories” on GitHub/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "octocat/saale" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "octocat/docs" })).not.toBeChecked();
  });
});
