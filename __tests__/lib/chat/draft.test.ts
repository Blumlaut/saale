import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearDraft, draftStorageKey, loadDraft, saveDraft } from "@/lib/chat/draft";
import { installMemoryStorage, MemoryStorage } from "../../helpers/memory-storage";

/**
 * Composer drafts must survive navigation, so their storage behaviour is
 * load-bearing: a draft that cannot be read back, or one that leaks into
 * another session, is the bug this feature exists to prevent.
 */

beforeEach(() => {
  const globals: Record<string, unknown> = {};
  installMemoryStorage(globals);
  vi.stubGlobal("window", globals);
});

describe("chat drafts", () => {
  it("round-trips a draft per session", () => {
    saveDraft("session-a", "half-typed thought");
    saveDraft("session-b", "another chat");

    expect(loadDraft("session-a")).toBe("half-typed thought");
    expect(loadDraft("session-b")).toBe("another chat");
  });

  it("returns an empty string for an unknown session", () => {
    expect(loadDraft("never-seen")).toBe("");
  });

  it("clears the entry when the draft is emptied or cleared", () => {
    saveDraft("session-a", "text");
    saveDraft("session-a", "");
    expect(window.localStorage.getItem(draftStorageKey("session-a"))).toBeNull();

    saveDraft("session-b", "text");
    clearDraft("session-b");
    expect(loadDraft("session-b")).toBe("");
  });

  it("recovers from a corrupted entry instead of throwing", () => {
    window.localStorage.setItem(draftStorageKey("session-a"), "{not json");

    expect(loadDraft("session-a")).toBe("");
  });

  it("keeps the most recently edited drafts when the cap is exceeded", () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    for (let i = 0; i < 55; i++) {
      saveDraft(`session-${i}`, `draft ${i}`);
      clock += 1_000;
    }
    nowSpy.mockRestore();

    // The oldest drafts were dropped, the newest kept.
    expect(loadDraft("session-0")).toBe("");
    expect(loadDraft("session-4")).toBe("");
    expect(loadDraft("session-5")).toBe("draft 5");
    expect(loadDraft("session-54")).toBe("draft 54");
  });

  it("truncates drafts to the message length limit", () => {
    saveDraft("session-a", "x".repeat(120_000));

    expect(loadDraft("session-a")).toHaveLength(100_000);
  });
});

describe("chat drafts without storage", () => {
  it("no-ops when localStorage is unavailable (SSR)", () => {
    vi.stubGlobal("window", undefined);

    expect(loadDraft("session-a")).toBe("");
    expect(() => saveDraft("session-a", "text")).not.toThrow();
    expect(() => clearDraft("session-a")).not.toThrow();
  });

  it("logs and continues when storage throws", () => {
    const failing = new MemoryStorage();
    vi.spyOn(failing, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.stubGlobal("window", { localStorage: failing });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => saveDraft("session-a", "text")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("Failed to save chat draft:", expect.any(Error));
  });
});
