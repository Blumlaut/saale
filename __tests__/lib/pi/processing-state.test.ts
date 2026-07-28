import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt } from "@/lib/pi/processing-state";

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

  it("includes all sections when all tools enabled", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "Be friendly.",
      toolConfig: { terminal: true, memory: true },
    });
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Custom instructions:\nBe friendly.");
    expect(prompt).toContain("A Terminal is available");
    expect(prompt).toContain("persistent memory system");
  });
});
