import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The coder panel runs git through the sandbox container, and the model runs
 * `gh` with the user's token. Both have to be in the image, and a base image
 * swap or a slimmer package list would silently take them away.
 */
/** Every package the image installs with apt. */
function aptPackages(dockerfile: string): string[] {
  const packages = new Set<string>();
  for (const match of dockerfile.matchAll(/apt-get install[^\\]*((?:[^\\]*\\\n)*[^\\]*)/g)) {
    for (const word of (match[1] ?? "").split(/\s+/)) {
      const name = word.trim();
      if (name && !name.startsWith("-") && name !== "apt-get") packages.add(name);
    }
  }
  return [...packages];
}

describe("Dockerfile.sandbox", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile.sandbox"), "utf8");

  it("installs git", () => {
    // it is one entry of the apt list, so match the package, not a line.
    expect(aptPackages(dockerfile)).toContain("git");
  });

  it("installs the GitHub CLI from its own repository", () => {
    expect(dockerfile).toContain("cli.github.com/packages");
    expect(aptPackages(dockerfile)).toContain("gh");
  });

  it("puts the workspace on HOME, so one .gitconfig serves the whole workspace", () => {
    expect(dockerfile).toContain("ENV HOME=/workspaces");
  });
});
