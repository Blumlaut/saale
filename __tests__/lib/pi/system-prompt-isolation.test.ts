/**
 * Prompt source isolation.
 *
 * Pi's resource loader *discovers* `<agentDir>/APPEND_SYSTEM.md` and appends it
 * to the system prompt as an `addendum` section. Saale passes the host's Pi
 * directory as `agentDir` (for settings), so an operator with that file would
 * otherwise have their text injected into every tenant's prompt  the same
 * class of leak as the host's model credentials and MCP config.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

const HOST_TEXT = "HOST OPERATOR ONLY  internal runbook";

function makeAgentDirWithAppendPrompt(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-agentdir-"));
  fs.writeFileSync(path.join(dir, "APPEND_SYSTEM.md"), HOST_TEXT);
  return dir;
}

describe("append system prompt isolation", () => {
  const previousAgentDir = process.env.PI_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
  });

  it("would otherwise discover the host's APPEND_SYSTEM.md", async () => {
    // Documents the mechanism the fix defends against: omitting the option
    // makes the loader read the file out of the host's Pi directory.
    const agentDir = makeAgentDirWithAppendPrompt();
    process.env.PI_AGENT_DIR = agentDir;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "saale-cwd-"));

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPrompt: "You are Saale.",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    expect(loader.getAppendSystemPrompt()).toEqual([HOST_TEXT]);
  });

  it("keeps the host's APPEND_SYSTEM.md out of a Saale session", async () => {
    process.env.PI_AGENT_DIR = makeAgentDirWithAppendPrompt();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "saale-cwd-"));

    const loader = await createSystemPromptLoader("You are Saale.", cwd);

    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });
});
