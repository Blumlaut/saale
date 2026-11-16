import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  globalSkillsDir,
  installGlobalSkill,
  listGlobalSkills,
  parseSkillMarkdown,
  removeGlobalSkill,
} from "@/lib/skills/global";
import { userIdentity } from "@/lib/sandbox/identity";
import { restoreEnv } from "../../helpers/env";

/**
 * Global skills are files in the user's workspace, so a lot of this is about
 * the boundary: the directory a name reaches, and the reasons a skill is
 * refused before it lands there.
 */

const USER = "user-1";

const mockFetchUrl = vi.fn();
vi.mock("@/lib/web/fetch", () => ({
  fetchUrl: (...args: unknown[]) => mockFetchUrl(...args),
}));

let volumeDir = "";
let workspace = "";
let originalWorkspacesDir: string | undefined;
let originalUser: string | undefined;
let originalUid: string | undefined;
let originalGid: string | undefined;

const VALID = [
  "---",
  "name: pdf-tools",
  "description: Extract text and tables from PDFs. Use when reading a PDF.",
  "---",
  "",
  "# PDF tools",
  "",
  "Read `references/formats.md` before converting.",
].join("\n");

beforeEach(async () => {
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  originalUser = process.env.SANDBOX_USER;
  originalUid = process.env.SANDBOX_UID;
  originalGid = process.env.SANDBOX_GID;
  volumeDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-skills-"));
  process.env.SANDBOX_WORKSPACES_DIR = volumeDir;
  // A root container has no owner to chown files to.
  process.env.SANDBOX_USER = "root";
  process.env.SANDBOX_UID = "0";
  process.env.SANDBOX_GID = "0";
  workspace = path.join(volumeDir, userIdentity(USER));
  await fs.mkdir(workspace, { recursive: true });
  mockFetchUrl.mockReset();
});

afterEach(async () => {
  restoreEnv("SANDBOX_WORKSPACES_DIR", originalWorkspacesDir);
  restoreEnv("SANDBOX_USER", originalUser);
  restoreEnv("SANDBOX_UID", originalUid);
  restoreEnv("SANDBOX_GID", originalGid);
  await fs.rm(volumeDir, { recursive: true, force: true });
});

describe("installGlobalSkill", () => {
  it("writes the skill into the workspace and lists it back", async () => {
    const result = await installGlobalSkill(USER, { markdown: VALID });

    expect(result).toMatchObject({
      ok: true,
      skill: { name: "pdf-tools", description: expect.stringContaining("Extract text") },
    });
    const file = path.join(globalSkillsDir(USER), "pdf-tools", "SKILL.md");
    await expect(fs.readFile(file, "utf8")).resolves.toBe(VALID);
    await expect(listGlobalSkills(USER)).resolves.toEqual([
      {
        name: "pdf-tools",
        description: "Extract text and tables from PDFs. Use when reading a PDF.",
        path: file,
      },
    ]);
  });

  it("replaces a skill of the same name", async () => {
    await installGlobalSkill(USER, { markdown: VALID });
    const updated = VALID.replace("Read `references/formats.md`", "Read `references/tables.md`");
    await installGlobalSkill(USER, { markdown: updated });

    const listed = await listGlobalSkills(USER);
    expect(listed).toHaveLength(1);
    await expect(
      fs.readFile(path.join(globalSkillsDir(USER), "pdf-tools", "SKILL.md"), "utf8"),
    ).resolves.toBe(updated);
  });

  it("reads the skill from an address", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/SKILL.md",
      finalUrl: "https://example.com/SKILL.md",
      statusCode: 200,
      mimeType: "text/markdown",
      contentLength: VALID.length,
      title: undefined,
      author: undefined,
      description: undefined,
      siteName: undefined,
      publishedDate: undefined,
      content: VALID,
      format: "raw",
    });

    const result = await installGlobalSkill(USER, { url: "https://example.com/SKILL.md" });

    expect(result).toMatchObject({ ok: true, skill: { name: "pdf-tools" } });
    expect(mockFetchUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/SKILL.md", format: "raw" }),
    );
  });

  it("refuses an address that did not answer with the file", async () => {
    mockFetchUrl.mockResolvedValue({
      error: "Access to internal addresses is not allowed: 10.0.0.4",
      code: "blocked_host",
      phase: "validation",
      retryable: false,
      url: "http://10.0.0.4/SKILL.md",
      finalUrl: undefined,
      statusCode: undefined,
    });

    const result = await installGlobalSkill(USER, { url: "http://10.0.0.4/SKILL.md" });

    expect(result).toEqual({
      ok: false,
      error: "Could not fetch the skill: Access to internal addresses is not allowed: 10.0.0.4",
      status: 502,
    });
    await expect(listGlobalSkills(USER)).resolves.toEqual([]);
  });

  it("refuses a skill that came back cut short", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/SKILL.md",
      finalUrl: "https://example.com/SKILL.md",
      statusCode: 200,
      content: `${VALID}\n\n... [truncated]`,
      format: "raw",
    });

    const result = await installGlobalSkill(USER, { url: "https://example.com/SKILL.md" });

    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it("refuses a name that would leave its own directory", async () => {
    const result = await installGlobalSkill(USER, {
      markdown: VALID.replace("name: pdf-tools", "name: ../../escape"),
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });
});

describe("parseSkillMarkdown", () => {
  it("asks for the file when nothing was given", () => {
    expect(parseSkillMarkdown("  ")).toEqual({
      ok: false,
      error: "Paste the skill's SKILL.md, or give an address to read it from.",
    });
  });

  it("names the field that is missing", () => {
    expect(parseSkillMarkdown("---\ndescription: Does things.\n---\n\nBody")).toEqual({
      ok: false,
      error: "The frontmatter needs a name, e.g. `name: pdf-tools`.",
    });
    expect(parseSkillMarkdown("---\nname: pdf-tools\n---\n\nBody")).toEqual({
      ok: false,
      error:
        "The frontmatter needs a description: it is what tells the model when to use the skill.",
    });
  });

  it("turns down a name Pi would not accept", () => {
    expect(
      parseSkillMarkdown("---\nname: PDF_Tools\ndescription: Does things.\n---\n\nBody"),
    ).toEqual({
      ok: false,
      error:
        '"PDF_Tools" is not a skill name: lowercase letters, digits and single hyphens, up to 64 characters.',
    });
  });

  it("turns down a description over the limit", () => {
    const long = "a".repeat(1025);
    expect(parseSkillMarkdown(`---\nname: thing\ndescription: ${long}\n---\n\nBody`)).toEqual({
      ok: false,
      error: "The description is longer than 1024 characters.",
    });
  });

  it("needs instructions below the frontmatter", () => {
    expect(parseSkillMarkdown("---\nname: thing\ndescription: Does things.\n---\n\n")).toEqual({
      ok: false,
      error: "The skill has no instructions below its frontmatter.",
    });
  });
});

describe("removeGlobalSkill", () => {
  it("removes an installed skill and says it was there", async () => {
    await installGlobalSkill(USER, { markdown: VALID });

    await expect(removeGlobalSkill(USER, "pdf-tools")).resolves.toBe(true);
    await expect(listGlobalSkills(USER)).resolves.toEqual([]);
    await expect(removeGlobalSkill(USER, "pdf-tools")).resolves.toBe(false);
  });

  it("refuses a name that is not a skill name", async () => {
    await expect(removeGlobalSkill(USER, "../..")).resolves.toBe(false);
    await expect(removeGlobalSkill(USER, "PDF_Tools")).resolves.toBe(false);
  });
});
