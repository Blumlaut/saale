import { describe, it, expect } from "vitest";

// Test the splitMessage utility (extracted for testing)
// This is the same logic as in src/lib/telegram/client.ts

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("Hello, world!", 4096);
    expect(result).toEqual(["Hello, world!"]);
  });

  it("splits at word boundary for long messages", () => {
    const words = Array(1000).fill("word");
    const text = words.join(" ");
    const result = splitMessage(text, 4096);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("force splits when no space found", () => {
    const text = "a".repeat(5000);
    const result = splitMessage(text, 4096);
    expect(result.length).toBe(2);
    expect(result[0]!.length).toBe(4096);
    expect(result[1]!.length).toBe(904);
  });

  it("splits at newline when no space found", () => {
    const text = "a".repeat(3000) + "\n" + "b".repeat(2000);
    const result = splitMessage(text, 4096);
    expect(result.length).toBe(2);
  });

  it("handles empty string", () => {
    const result = splitMessage("", 4096);
    expect(result).toEqual([""]);
  });

  it("handles exact length message", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text, 4096);
    expect(result).toEqual([text]);
  });

  it("trims whitespace between chunks", () => {
    const text = "a".repeat(4094) + "  " + "b".repeat(100);
    const result = splitMessage(text, 4096);
    expect(result.length).toBe(2);
    expect(result[1]?.[0]).not.toBe(" ");
  });
});

/**
 * Split a message into chunks that fit within Telegram's 4096 character limit.
 * Tries to split at word boundaries to avoid cutting words in half.
 * (Same implementation as in src/lib/telegram/client.ts)
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (at a space or newline)
    let splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt === -1) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt === -1) {
      // No space found — force split at maxLength
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
