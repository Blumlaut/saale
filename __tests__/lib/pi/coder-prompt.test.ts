import { describe, it, expect } from "vitest";
import { buildCoderSystemPrompt } from "@/lib/pi/coder-prompt";

/**
 * The coder prompt carries the git rules the panel's bookkeeping depends on,
 * and it describes exactly the tools the coder tool config enables. Callers
 * pass that config explicitly (its defaults are the coder ones), so these cases
 * never lean on a wake-up default.
 */

describe("buildCoderSystemPrompt git rules", () => {
  const prompt = buildCoderSystemPrompt({ toolConfig: { terminal: true } });

  it("says the worktree is the whole filesystem authority", () => {
    expect(prompt).toContain("one git worktree");
    expect(prompt).toContain("Every path outside it is out of bounds");
  });

  it("carries the commit rules", () => {
    expect(prompt).toContain("Commit as work lands, in small commits");
    expect(prompt).toContain("shorter than 50 characters");
    expect(prompt).toContain("No attribution trailers");
    expect(prompt).toContain("Run the project's own checks");
  });

  it("forbids force, unsolicited pushes and history rewrites", () => {
    expect(prompt).toContain("Never pass `--force`");
    expect(prompt).toContain("Never push unless the user asks");
    expect(prompt).toContain("Only this worktree's branch is yours to change");
    expect(prompt).toContain("Never rewrite history that exists on a remote");
  });

  it("asks for a report of what changed, what is committed, what is dirty", () => {
    expect(prompt).toContain("what you changed");
    expect(prompt).toContain("what you committed");
    expect(prompt).toContain("what is still uncommitted");
  });
});

describe("buildCoderSystemPrompt capability sections", () => {
  it("describes the terminal contract only while that category is on", () => {
    const on = buildCoderSystemPrompt({ toolConfig: { terminal: true } });
    expect(on).toContain("A Terminal is available");
    expect(on).toContain("`read` rather than cat/sed");

    const off = buildCoderSystemPrompt({ toolConfig: { terminal: false } });
    expect(off).not.toContain("A Terminal is available");
    expect(off).not.toContain("`read` rather than cat/sed");
  });

  it("drops every other disabled category's section too", () => {
    const off = buildCoderSystemPrompt({ toolConfig: { memory: false, infra: false } });
    expect(off).not.toContain("persistent memory system");
    expect(off).not.toContain("Infrastructure notes");
    // The codemode guidance survives: it is about the route to any tool.
    expect(off).toContain("Tool use:");

    const on = buildCoderSystemPrompt({ toolConfig: { memory: true, infra: true } });
    expect(on).toContain("persistent memory system");
    expect(on).toContain("Infrastructure notes");
  });

  it("describes the same sections a chat does for the same config", () => {
    const config = { terminal: true, memory: true, telegram: true, agentJobs: true };
    const prompt = buildCoderSystemPrompt({ toolConfig: config });
    expect(prompt).toContain("`telegram_send`");
    expect(prompt).toContain("`agent_job_create`");

    // `telegram` sits at its registry default when the config omits it, so turn
    // it off explicitly to see the section go.
    const quiet = buildCoderSystemPrompt({
      toolConfig: { terminal: true, agentJobs: true, telegram: false },
    });
    expect(quiet).not.toContain("`telegram_send`");
    expect(quiet).not.toContain("`agent_job_create`");
  });
});

describe("buildCoderSystemPrompt sandbox variables", () => {
  it("mentions GH_TOKEN only when the user has that variable", () => {
    const withToken = buildCoderSystemPrompt({
      toolConfig: { terminal: true },
      sandboxEnvNames: ["GH_TOKEN"],
    });
    expect(withToken).toContain("`GH_TOKEN` is set in your environment");

    const without = buildCoderSystemPrompt({
      toolConfig: { terminal: true },
      sandboxEnvNames: ["OPENAI_API_KEY"],
    });
    expect(without).not.toContain("`GH_TOKEN`");
    // The names still reach the terminal section, and only the names.
    expect(without).toContain("OPENAI_API_KEY");
    expect(without).toContain("Their values are not shown to you.");
  });

  it("keeps another variable's name out of the GH_TOKEN sentence", () => {
    const prompt = buildCoderSystemPrompt({
      toolConfig: { terminal: true },
      sandboxEnvNames: ["OPENAI_API_KEY"],
    });
    expect(prompt).not.toContain("private repositories");
  });
});

describe("buildCoderSystemPrompt custom instructions", () => {
  it("appends them after the identity block", () => {
    const prompt = buildCoderSystemPrompt({
      toolConfig: { terminal: true },
      customInstructions: "Always use tabs.",
    });
    const identity = prompt.indexOf("You are Saale's coding agent");
    const custom = prompt.indexOf("Custom instructions:\nAlways use tabs.");
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(custom).toBeGreaterThan(identity);
    // Before the git rules, which follow the user's own instructions.
    expect(custom).toBeLessThan(prompt.indexOf("Git:"));
  });

  it("skips an empty one", () => {
    expect(buildCoderSystemPrompt({ customInstructions: "  " })).not.toContain(
      "Custom instructions",
    );
    expect(buildCoderSystemPrompt({ customInstructions: null })).not.toContain(
      "Custom instructions",
    );
  });
});
