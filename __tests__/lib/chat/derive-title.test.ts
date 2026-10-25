import { describe, expect, it } from "vitest";
import { deriveChatTitle } from "@/lib/chat/derive-title";

describe("deriveChatTitle", () => {
  it("names the task from an imperative prompt", () => {
    expect(deriveChatTitle("can you add a dark mode toggle to the settings page")).toBe(
      "Add dark mode toggle to settings page",
    );
    expect(deriveChatTitle("help me debug this webhook signature error from stripe")).toBe(
      "Debug webhook signature error from stripe",
    );
  });

  it("drops the question scaffolding and keeps the subject", () => {
    expect(
      deriveChatTitle(
        "why does the prisma migration fail on deploy, it says column already exists",
      ),
    ).toBe("Prisma migration fail on deploy");
    expect(deriveChatTitle("how do I add a new agent tool in saale")).toBe(
      "Add new agent tool in saale",
    );
  });

  it("stops at the clause that names the chat", () => {
    expect(
      deriveChatTitle("the docker build keeps failing because of missing sharp binaries"),
    ).toBe("Docker build keeps failing");
    expect(
      deriveChatTitle("our team standup notes from yesterday, can you turn them into a task list"),
    ).toBe("Team standup notes from yesterday");
  });

  it("keeps negations", () => {
    expect(deriveChatTitle("the login button doesn't work on safari")).toBe(
      "Login button not work on safari",
    );
  });

  it("keeps file names whole", () => {
    expect(deriveChatTitle("please fix the flaky test in e2e/mobile-overflow.spec.ts")).toBe(
      "Fix flaky test in e2e/mobile-overflow.spec.ts",
    );
  });

  it("reads the prompt, not the markdown around it", () => {
    expect(
      deriveChatTitle("review this diff\n\n```diff\n-const a = 1\n+const a = 2\n```\nlooks fine?"),
    ).toBe("Review diff looks fine");
  });

  it("stays within the title length", () => {
    const long = deriveChatTitle(
      "compare redis and postgres for storing chat drafts before the sidebar rework ships",
    );
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(50);
  });

  it("returns null when the prompt cannot name a topic", () => {
    expect(deriveChatTitle("")).toBeNull();
    expect(deriveChatTitle("hi")).toBeNull();
    expect(deriveChatTitle("i")).toBeNull();
    expect(deriveChatTitle("```ts\nconst x = 1;\n```")).toBeNull();
    expect(deriveChatTitle("deadbeefcafebabe0123456789abcdef0123456789")).toBeNull();
  });

  it("returns the same title for the same prompt", () => {
    const prompt = "the chat list is not scrolling on mobile, it overflows the screen";
    expect(deriveChatTitle(prompt)).toBe(deriveChatTitle(prompt));
    expect(deriveChatTitle(prompt)).toBe("Chat list not scrolling on mobile");
  });
});
