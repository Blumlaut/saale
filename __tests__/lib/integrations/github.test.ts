import { describe, expect, it } from "vitest";
import { findDeviceCode, parseGithubHosts } from "@/lib/integrations/github";

/** A `gh auth status --json hosts` answer, as gh 2.103 prints it. */
function hostsJson(entry: Record<string, unknown>, host = "github.com"): string {
  return JSON.stringify({ hosts: { [host]: [entry] } });
}

describe("parseGithubHosts", () => {
  it("reads the login, scopes and source of a gh login", () => {
    const probe = parseGithubHosts(
      hostsJson({
        state: "success",
        active: true,
        host: "github.com",
        login: "octocat",
        tokenSource: "/w/.config/gh/hosts.yml",
        scopes: "gist, read:org, repo, workflow",
        gitProtocol: "https",
      }),
    );

    expect(probe).toEqual({
      credential: {
        host: "github.com",
        login: "octocat",
        scopes: "gist, read:org, repo, workflow",
        gitProtocol: "https",
        source: "/w/.config/gh/hosts.yml",
      },
      error: null,
    });
  });

  it("reports a token variable as the source", () => {
    const probe = parseGithubHosts(
      hostsJson({ state: "success", active: true, login: "octocat", tokenSource: "GH_TOKEN" }),
    );

    expect(probe.credential?.source).toBe("GH_TOKEN");
  });

  it("has no credential when gh holds none", () => {
    expect(parseGithubHosts('{"hosts":{}}')).toEqual({ credential: null, error: null });
  });

  it("reports a token GitHub refused instead of a connection", () => {
    const probe = parseGithubHosts(
      hostsJson({
        state: "error",
        active: true,
        login: "",
        tokenSource: "GH_TOKEN",
        error: "non-200 OK status code: 401 Unauthorized body: Bad credentials",
      }),
    );

    expect(probe.credential).toBeNull();
    expect(probe.error).toContain("401 Unauthorized");
  });

  it("takes the active host when an enterprise host is listed too", () => {
    const stdout = JSON.stringify({
      hosts: {
        "ghe.example.com": [{ active: false, login: "someone-else", tokenSource: "/gh/hosts.yml" }],
        "github.com": [{ active: true, login: "octocat", tokenSource: "/gh/hosts.yml" }],
      },
    });

    expect(parseGithubHosts(stdout).credential?.login).toBe("octocat");
  });

  it("has nothing to say about output that is not a status", () => {
    expect(parseGithubHosts("")).toEqual({ credential: null, error: null });
    expect(parseGithubHosts("You are not logged into any GitHub hosts.")).toEqual({
      credential: null,
      error: null,
    });
  });
});

describe("findDeviceCode", () => {
  it("reads the code gh prints before polling", () => {
    const output = [
      "! Failed to copy one-time code to clipboard",
      "! First copy your one-time code: 1b47-abe8",
      "Open this URL to continue in your web browser: https://github.com/login/device",
    ].join("\n");

    expect(findDeviceCode(output)).toBe("1B47-ABE8");
  });

  it("waits while the code is still on its way", () => {
    expect(findDeviceCode("The value of the GH_TOKEN environment variable is being used")).toBe(
      null,
    );
  });

  it("ignores a code typed into something else", () => {
    expect(findDeviceCode("First copy your one-time code: 12AB")).toBeNull();
  });
});
