import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt, createSystemPromptLoader } from "@/lib/pi/processing-state";

describe("buildAgentSystemPrompt", () => {
  it("returns default prompt with no options", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Be concise and direct");
    expect(prompt).not.toContain("Custom instructions");
    expect(prompt).not.toContain("Terminal");
    expect(prompt).toContain("persistent memory system");
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
  });

  it("skips terminal instruction when terminal tool is disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { terminal: false } });
    expect(prompt).not.toContain("A Terminal is available");
  });

  it("skips terminal instruction when not specified", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: {} });
    expect(prompt).not.toContain("A Terminal is available");
  });

  it("includes memory instruction by default", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("persistent memory system");
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

  it("skips infrastructure instruction when not specified", () => {
    expect(buildAgentSystemPrompt({ toolConfig: {} })).not.toContain("Infrastructure notes:");
    expect(buildAgentSystemPrompt({})).not.toContain("Infrastructure notes:");
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
    // Inline prompt — no file source, no append prompt
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("disables discovery so the session prompt stays clean", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saale-loader-"));
    const loader = await createSystemPromptLoader("test prompt", dir);

    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getExtensions().extensions).toEqual([]);
  });
});
