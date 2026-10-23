import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentSystemPrompt,
  createAgentResourceLoader,
  createSystemPromptLoader,
} from "@/lib/pi/processing-state";
import { sessionWorkspace } from "@/lib/pi/project-context";

describe("buildAgentSystemPrompt", () => {
  it("returns default prompt with no options", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Be concise and direct");
    expect(prompt).not.toContain("Custom instructions");
    // Terminal and memory default on, and the tools are resolved with those same
    // defaults  so the prompt must describe them without being asked.
    expect(prompt).toContain("A Terminal is available");
    expect(prompt).toContain("persistent memory system");
  });

  it("tells the model how to reach hidden tools", () => {
    // Pi's own "use codemode to batch calls" guideline lives in the default
    // system prompt, which a custom prompt replaces  so Saale states it here.
    for (const config of [undefined, {}, { terminal: false, memory: false }]) {
      const prompt = buildAgentSystemPrompt(config ? { toolConfig: config } : {});
      expect(prompt).toContain("Tool use:");
      expect(prompt).toContain("tools.<name>");
      expect(prompt).toContain("searchTools");
    }
  });

  it("leaves codemode out of a session that has nothing behind it", () => {
    const prompt = buildAgentSystemPrompt({ codemodeTools: false });

    expect(prompt).not.toContain("Tool use:");
    expect(prompt).not.toContain("searchTools");
    // The tools the session does have are still described.
    expect(prompt).toContain("A Terminal is available");
  });

  it("includes custom instructions when provided", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "Always respond in Spanish.",
    });
    expect(prompt).toContain("Custom instructions:\nAlways respond in Spanish.");
  });

  it("skips empty custom instructions", () => {
    const prompt = buildAgentSystemPrompt({ customInstructions: "   " });
    expect(prompt).not.toContain("Custom instructions");
  });

  it("skips null custom instructions", () => {
    const prompt = buildAgentSystemPrompt({ customInstructions: null });
    expect(prompt).not.toContain("Custom instructions");
  });

  it("includes terminal instruction when terminal tool is enabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { terminal: true } });
    expect(prompt).toContain("A Terminal is available");
    // The file-tool usage rules Pi keeps in its own rules section.
    expect(prompt).toContain("`read` rather than cat/sed");
    expect(prompt).toContain("edits[].oldText` must match the file exactly");
  });

  it("skips terminal instruction when terminal tool is disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { terminal: false } });
    expect(prompt).not.toContain("A Terminal is available");
  });

  it("includes terminal instruction by default", () => {
    // The chat stores a null toolConfig; the tools still default on, so the
    // capability block must appear rather than the model being left unaware of
    // `write`.
    expect(buildAgentSystemPrompt({ toolConfig: {} })).toContain("A Terminal is available");
    expect(buildAgentSystemPrompt({})).toContain("A Terminal is available");
  });

  it("includes terminal instruction for legacy files/bash keys", () => {
    expect(buildAgentSystemPrompt({ toolConfig: { files: true } })).toContain(
      "A Terminal is available",
    );
    expect(buildAgentSystemPrompt({ toolConfig: { bash: true } })).toContain(
      "A Terminal is available",
    );
  });

  it("includes memory instruction by default", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("persistent memory system");
    // The model must know it can save, update and delete, not just search.
    expect(prompt).toContain("memory_create");
    expect(prompt).toContain("memory_update");
    expect(prompt).toContain("memory_delete");
  });

  it("skips memory instruction when explicitly disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { memory: false } });
    expect(prompt).not.toContain("persistent memory system");
  });

  it("includes infrastructure notes instruction when infra tool is enabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { infra: true } });
    expect(prompt).toContain("Infrastructure notes:");
    // Read-first: notes are the source of truth, not a scratchpad.
    expect(prompt).toContain("Read them");
    // Is-state only: no plans, intentions, TODOs or ephemeral values.
    expect(prompt).toContain("true now");
    expect(prompt).toContain("plans, intentions, TODOs");
    // No duplicates: update the matching note by id.
    expect(prompt).toContain("exactly one note");
    expect(prompt).toContain("update the matching note by id");
    // Delete when stale.
    expect(prompt).toContain("stale note is worse than no note");
  });

  it("skips infrastructure instruction when infra tool is disabled", () => {
    expect(buildAgentSystemPrompt({ toolConfig: { infra: false } })).not.toContain(
      "Infrastructure notes:",
    );
  });

  it("includes infrastructure instruction by default", () => {
    // Every category defaults on; the prompt must not disagree with the tools.
    expect(buildAgentSystemPrompt({ toolConfig: {} })).toContain("Infrastructure notes:");
    expect(buildAgentSystemPrompt({})).toContain("Infrastructure notes:");
  });

  it("includes all sections when all tools enabled", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "Be friendly.",
      toolConfig: { terminal: true, memory: true, infra: true },
    });
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Custom instructions:\nBe friendly.");
    expect(prompt).toContain("A Terminal is available");
    expect(prompt).toContain("persistent memory system");
    expect(prompt).toContain("Infrastructure notes:");
  });

  it("tells the model it can reach the user when Telegram is enabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { telegram: true } });

    // The agent has to know outreach exists, or "remind me" becomes a promise
    // it cannot keep.
    expect(prompt).toContain("telegram_send");
    expect(prompt).toContain("cannot be chosen");
  });

  it("skips the outreach instruction when Telegram is disabled", () => {
    expect(buildAgentSystemPrompt({ toolConfig: { telegram: false } })).not.toContain(
      "telegram_send",
    );
  });

  it("includes outreach and scheduling instructions by default", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: {} });

    expect(prompt).toContain("telegram_send");
    // Both categories default on, so the agent is told how to send something
    // later rather than only how to send it now.
    expect(prompt).toContain("agent_job_create");
  });

  it("omits the scheduling instruction when agent jobs are disabled", () => {
    // Naming agent_job_create to a session without it would describe a tool the
    // model cannot call.
    const prompt = buildAgentSystemPrompt({ toolConfig: { telegram: true, agentJobs: false } });

    expect(prompt).toContain("telegram_send");
    expect(prompt).not.toContain("agent_job_create");
  });

  it("omits the scheduling instruction when Telegram is disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { telegram: false, agentJobs: true } });

    expect(prompt).not.toContain("agent_job_create");
  });

  it("trims user custom instructions", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "  Be friendly.  ",
    });
    expect(prompt).toContain("Custom instructions:\nBe friendly.");
    expect(prompt).not.toContain("Custom instructions:\n  Be friendly.");
  });
});

describe("createSystemPromptLoader", () => {
  it("serves the given prompt verbatim with no file source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-loader-"));
    const multiLine =
      "You are Saale, a personal AI assistant.\n\nGuidelines:\n- Be concise and direct.";
    const loader = await createSystemPromptLoader(multiLine, dir);

    expect(loader.getSystemPrompt()).toBe(multiLine);
    // Inline prompt  no file source, no append prompt
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("disables discovery so the session prompt stays clean", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-loader-"));
    const loader = await createSystemPromptLoader("test prompt", dir);

    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
  });

  it("loads only Saale's own extensions, never the host's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-loader-"));
    const loader = await createSystemPromptLoader("test prompt", dir);

    // Exactly one extension  Saale's inline codemode. Discovery of the host's
    // Pi directory is off, so nothing from the machine can be loaded.
    const extensions = loader.getExtensions().extensions;
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.path).toContain("inline");
  });
});

describe("createAgentResourceLoader: workspace", () => {
  let volumeDir = "";
  let originalWorkspacesDir: string | undefined;

  beforeEach(async () => {
    originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
    volumeDir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-loader-workspace-"));
    process.env.SANDBOX_WORKSPACES_DIR = volumeDir;
  });

  afterEach(() => {
    process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
    fs.rmSync(volumeDir, { recursive: true, force: true });
  });

  it("reads the worktree's AGENTS.md and skills", async () => {
    const root = path.join(volumeDir, "user-user-1");
    const worktree = path.join(root, "worktrees/saale/c-1");
    fs.mkdirSync(path.join(worktree, ".pi/skills/release"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "AGENTS.md"), "worktree rules");
    fs.writeFileSync(
      path.join(worktree, ".pi/skills/release/SKILL.md"),
      ["---", "name: release", "description: Cut a release", "---", "", "Steps."].join("\n"),
    );

    const loader = await createAgentResourceLoader({
      prompt: "test prompt",
      cwd: "/tmp/saale-loader-session",
      workspace: sessionWorkspace("user-1", worktree),
    });

    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { path: path.join(worktree, "AGENTS.md"), content: "worktree rules" },
    ]);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["release"]);
  });

  it("reads no file from above the workspace root", async () => {
    const root = path.join(volumeDir, "user-user-1");
    const worktree = path.join(root, "worktrees/saale/c-1");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(volumeDir, "AGENTS.md"), "the operator's rules");
    fs.writeFileSync(path.join(worktree, "AGENTS.md"), "the project's rules");

    const loader = await createAgentResourceLoader({
      prompt: "test prompt",
      cwd: "/tmp/saale-loader-session",
      workspace: sessionWorkspace("user-1", worktree),
    });

    expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual([
      "the project's rules",
    ]);
  });
});
