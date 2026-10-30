import { describe, expect, it } from "vitest";
import { commitWebUrl, remoteHostName, remoteWebUrl, repoWebUrl } from "@/lib/coder/remote-url";

/**
 * A remote's browsable address.
 *
 * Both spellings of a GitHub remote are in every repo here, and a wrong link is
 * a 404 in a new tab rather than an error anyone reads.
 */

describe("remoteWebUrl", () => {
  it("reads the scp-like form git clones with", () => {
    expect(remoteWebUrl("git@github.com:acme/saale.git")).toBe("https://github.com/acme/saale");
  });

  it("reads an https remote, with or without the suffix", () => {
    expect(remoteWebUrl("https://github.com/acme/saale.git")).toBe("https://github.com/acme/saale");
    expect(remoteWebUrl("https://github.com/acme/saale")).toBe("https://github.com/acme/saale");
  });

  it("keeps the host of a self-hosted forge", () => {
    expect(remoteWebUrl("git@git.acme.dev:team/repo.git")).toBe("https://git.acme.dev/team/repo");
  });

  it("has no page for a local path or an ssh alias", () => {
    expect(remoteWebUrl("/workspaces/user-1/projects/saale")).toBeNull();
    expect(remoteWebUrl("file:///tmp/repo")).toBeNull();
    expect(remoteWebUrl("")).toBeNull();
  });
});

describe("commitWebUrl", () => {
  it("points at the commit on the remote", () => {
    expect(commitWebUrl("git@github.com:acme/saale.git", "a1b2c3d4e5f6")).toBe(
      "https://github.com/acme/saale/commit/a1b2c3d4e5f6",
    );
  });

  it("refuses a ref that is not a sha", () => {
    expect(commitWebUrl("git@github.com:acme/saale.git", "HEAD~1")).toBeNull();
  });

  it("has nowhere to point without a remote page", () => {
    expect(commitWebUrl("/tmp/repo", "a1b2c3d")).toBeNull();
  });
});

describe("remoteHostName", () => {
  it("names the forge a link opens", () => {
    expect(remoteHostName("git@github.com:acme/saale.git")).toBe("GitHub");
    expect(remoteHostName("https://gitlab.com/acme/saale.git")).toBe("GitLab");
    expect(remoteHostName("https://codeberg.org/acme/saale")).toBe("Codeberg");
  });

  it("names a self-hosted forge by its host, which is all there is to say", () => {
    expect(remoteHostName("git@git.acme.dev:team/repo.git")).toBe("git.acme.dev");
  });

  it("has no name for a remote with no page", () => {
    expect(remoteHostName("/workspaces/user-1/projects/saale")).toBeNull();
  });
});

describe("repoWebUrl", () => {
  it("is the remote's own page", () => {
    expect(repoWebUrl("https://github.com/acme/saale.git")).toBe("https://github.com/acme/saale");
  });
});
