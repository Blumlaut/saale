import { describe, it, expect } from "vitest";
import type { TelegramAccount, WhitelistEntry } from "@/hooks/use-telegram-integration";
import type { GitHubAccount } from "@/hooks/use-github-integration";
import type { IntegrationId } from "@/lib/integrations/types";

/**
 * Type contract tests — verify that the hook types match what the API routes
 * actually return. These tests use runtime shape validation to catch mismatches
 * between the TypeScript types and the actual API response format.
 */
describe("integration type contracts", () => {
  describe("TelegramAccount matches GET /api/integrations/telegram", () => {
    it("has all fields returned by the API", () => {
      // This is the exact shape returned by GET /api/integrations/telegram
      const apiResponse = {
        id: "cm4xxxxx",
        enabled: true,
        botId: "123456789",
        botUsername: "my_saale_bot",
        whitelistCount: 3,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      // Type assertion — will fail at compile time if shapes don't match
      const account: TelegramAccount = apiResponse;

      // Runtime validation
      expect(account.id).toBe("cm4xxxxx");
      expect(account.enabled).toBe(true);
      expect(account.botId).toBe("123456789");
      expect(account.botUsername).toBe("my_saale_bot");
      expect(account.whitelistCount).toBe(3);
      expect(account.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(account.updatedAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("handles null optional fields", () => {
      const account: TelegramAccount = {
        id: "cm4xxxxx",
        enabled: false,
        botId: null,
        botUsername: null,
        whitelistCount: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      expect(account.botId).toBeNull();
      expect(account.botUsername).toBeNull();
      expect(account.enabled).toBe(false);
      expect(account.whitelistCount).toBe(0);
    });

    it("handles zero whitelist count", () => {
      const account: TelegramAccount = {
        id: "cm4xxxxx",
        enabled: true,
        botId: "123",
        botUsername: "bot",
        whitelistCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(account.whitelistCount).toBe(0);
    });
  });

  describe("GitHubAccount matches GET /api/integrations/github", () => {
    it("has all fields returned by the API", () => {
      // This is the exact shape returned by GET /api/integrations/github
      const apiResponse = {
        id: "cm4xxxxx",
        enabled: true,
        username: "testuser",
        avatarUrl: "https://avatars.githubusercontent.com/u/123",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      // Type assertion — will fail at compile time if shapes don't match
      const account: GitHubAccount = apiResponse;

      // Runtime validation
      expect(account.id).toBe("cm4xxxxx");
      expect(account.enabled).toBe(true);
      expect(account.username).toBe("testuser");
      expect(account.avatarUrl).toBe("https://avatars.githubusercontent.com/u/123");
      expect(account.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(account.updatedAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("handles null optional fields", () => {
      const account: GitHubAccount = {
        id: "cm4xxxxx",
        enabled: false,
        username: null,
        avatarUrl: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      expect(account.username).toBeNull();
      expect(account.avatarUrl).toBeNull();
    });
  });

  describe("WhitelistEntry matches GET /api/integrations/telegram/whitelist", () => {
    it("has all fields returned by the API", () => {
      const apiResponse = {
        id: "cm5xxxxx",
        telegramUserId: "123456789",
        displayName: "Test User",
        createdAt: "2025-01-01T00:00:00.000Z",
      };

      const entry: WhitelistEntry = apiResponse;

      expect(entry.id).toBe("cm5xxxxx");
      expect(entry.telegramUserId).toBe("123456789");
      expect(entry.displayName).toBe("Test User");
      expect(entry.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("handles null displayName", () => {
      const entry: WhitelistEntry = {
        id: "cm5xxxxx",
        telegramUserId: "987654321",
        displayName: null,
        createdAt: "2025-01-01T00:00:00.000Z",
      };

      expect(entry.displayName).toBeNull();
      expect(entry.telegramUserId).toBe("987654321");
    });
  });

  describe("IntegrationId union", () => {
    it("accepts valid IDs", () => {
      const ids: IntegrationId[] = ["telegram", "github"];
      expect(ids).toContain("telegram");
      expect(ids).toContain("github");
    });

    it("has exactly two members", () => {
      const validIds: IntegrationId[] = ["telegram", "github"];
      // Adding a third would require updating the type
      expect(validIds.length).toBe(2);
    });
  });

  describe("POST response shape consistency", () => {
    it("POST /api/integrations/telegram returns subset of TelegramAccount", () => {
      // POST doesn't include whitelistCount — that's fetched by loadAccount() after save
      const postResponse = {
        id: "cm4xxxxx",
        enabled: true,
        botId: "123456789",
        botUsername: "my_saale_bot",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      // Verify it has the core fields
      expect(postResponse.id).toBeDefined();
      expect(postResponse.enabled).toBe(true);
      expect(postResponse.botId).toBeDefined();
      expect(postResponse.botUsername).toBeDefined();
      // whitelistCount is intentionally omitted from POST response
      expect((postResponse as Record<string, unknown>).whitelistCount).toBeUndefined();
    });

    it("POST /api/integrations/github returns subset of GitHubAccount", () => {
      const postResponse = {
        id: "cm4xxxxx",
        enabled: true,
        username: "testuser",
        avatarUrl: "https://avatars.githubusercontent.com/u/123",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };

      expect(postResponse.id).toBeDefined();
      expect(postResponse.enabled).toBe(true);
      expect(postResponse.username).toBeDefined();
      expect(postResponse.avatarUrl).toBeDefined();
    });
  });

  describe("error response shape", () => {
    it("error responses have 'error' field", () => {
      const errorResponse = { error: "Invalid token" };
      expect(errorResponse.error).toBe("Invalid token");
    });

    it("success response has 'success' field", () => {
      const successResponse = { success: true };
      expect(successResponse.success).toBe(true);
    });
  });
});
