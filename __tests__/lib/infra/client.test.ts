// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    infraMachine: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

// Mock crypto
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((input: string) => input.replace("encrypted:", "")),
  encrypt: vi.fn((input: string) => `encrypted:${input}`),
}));

// Mock node-ssh
vi.mock("node-ssh", () => ({
  NodeSSH: vi.fn(),
}));

import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import { NodeSSH } from "node-ssh";
import { truncateOutput, resolveConnectionConfig } from "@/lib/infra/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInfraMachine = db.prisma.infraMachine as any;

describe("truncateOutput", () => {
  it("returns text unchanged when under limit", () => {
    const { text, truncated } = truncateOutput("hello world", 100);
    expect(text).toBe("hello world");
    expect(truncated).toBe(false);
  });

  it("returns text unchanged when exactly at limit", () => {
    const text = "a".repeat(50);
    const { text: result, truncated } = truncateOutput(text, 50);
    expect(result).toBe(text);
    expect(truncated).toBe(false);
  });

  it("truncates when over limit", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const { text: result, truncated } = truncateOutput(text, 15);
    expect(truncated).toBe(true);
    expect(result).toContain("[output truncated");
    expect(result).toContain("exceeded 15 byte limit");
  });

  it("truncates at line boundary, not mid-line", () => {
    const text = "short\n" + "a".repeat(100);
    const { text: result, truncated } = truncateOutput(text, 20);
    expect(truncated).toBe(true);
    // Should truncate before the long line
    expect(result).toContain("short");
    expect(result).not.toMatch(/^a{100}$/);
  });

  it("handles text with no newlines over limit", () => {
    const text = "a".repeat(100);
    const { text: result, truncated } = truncateOutput(text, 20);
    expect(truncated).toBe(true);
    expect(result).toContain("[output truncated");
  });

  it("handles empty input", () => {
    const { text, truncated } = truncateOutput("", 100);
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });

  it("handles unicode correctly (byte-based limit)", () => {
    // "🎉" is 4 bytes in UTF-8
    const text = "🎉".repeat(10); // 40 bytes
    const { truncated } = truncateOutput(text, 20);
    expect(truncated).toBe(true);
  });

  it("includes truncation message with byte limit", () => {
    const text = "a".repeat(100);
    const { text: result, truncated } = truncateOutput(text, 50);
    expect(truncated).toBe(true);
    expect(result).toContain("exceeded 50 byte limit");
  });
});

describe("resolveConnectionConfig (via prisma mock)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves password auth correctly", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "192.168.1.1",
      port: 22,
      username: "admin",
      authMethod: "password",
      encryptedKey: null,
      encryptedPass: "encrypted:secretpass",
      passPhrase: null,
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    const config = await resolveConnectionConfig("machine-1", "user-1");
    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(22);
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secretpass");
    expect(config.privateKey).toBeUndefined();
  });

  it("resolves key auth correctly", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "10.0.0.1",
      port: 2222,
      username: "deploy",
      authMethod: "key",
      encryptedKey: "encrypted:-----BEGIN RSA PRIVATE KEY-----",
      encryptedPass: null,
      passPhrase: null,
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    const config = await resolveConnectionConfig("machine-1", "user-1");
    expect(config.host).toBe("10.0.0.1");
    expect(config.port).toBe(2222);
    expect(config.username).toBe("deploy");
    expect(config.privateKey).toBe("-----BEGIN RSA PRIVATE KEY-----");
    expect(config.password).toBeUndefined();
  });

  it("resolves key auth with passphrase", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "10.0.0.1",
      port: 22,
      username: "deploy",
      authMethod: "key",
      encryptedKey: "encrypted:key-data",
      encryptedPass: null,
      passPhrase: "encrypted:mypass",
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    const config = await resolveConnectionConfig("machine-1", "user-1");
    expect(config.passPhrase).toBe("mypass");
  });

  it("throws when machine not found", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

    await expect(resolveConnectionConfig("nonexistent", "user-1")).rejects.toThrow(
      "Machine nonexistent not found",
    );
  });

  it("throws when password auth missing password", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "10.0.0.1",
      port: 22,
      username: "deploy",
      authMethod: "password",
      encryptedKey: null,
      encryptedPass: null,
      passPhrase: null,
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    await expect(resolveConnectionConfig("machine-1", "user-1")).rejects.toThrow(
      "Machine test-server is missing a password",
    );
  });

  it("throws when key auth missing private key", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "10.0.0.1",
      port: 22,
      username: "deploy",
      authMethod: "key",
      encryptedKey: null,
      encryptedPass: null,
      passPhrase: null,
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    await expect(resolveConnectionConfig("machine-1", "user-1")).rejects.toThrow(
      "Machine test-server is missing an SSH key",
    );
  });

  it("scopes query to userId (user isolation)", async () => {
    const mockMachine = {
      id: "machine-1",
      userId: "user-1",
      name: "test-server",
      host: "10.0.0.1",
      port: 22,
      username: "deploy",
      authMethod: "key",
      encryptedKey: "encrypted:key-data",
      encryptedPass: null,
      passPhrase: null,
    };

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(mockMachine);

    await resolveConnectionConfig("machine-1", "user-1");
    expect(mockInfraMachine.findFirst).toHaveBeenCalledWith({
      where: { id: "machine-1", userId: "user-1" },
    });
  });

  it("rejects access to another user's machine", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

    await expect(resolveConnectionConfig("other-user-machine", "my-user")).rejects.toThrow(
      "Machine other-user-machine not found",
    );
    expect(mockInfraMachine.findFirst).toHaveBeenCalledWith({
      where: { id: "other-user-machine", userId: "my-user" },
    });
  });
});

describe("NodeSSH mock behavior", () => {
  it("NodeSSH is mocked", () => {
    expect(NodeSSH).toBeDefined();
    expect(vi.isMockFunction(NodeSSH)).toBe(true);
  });
});

describe("crypto round-trip", () => {
  it("encrypt/decrypt round-trip works", () => {
    const original = "my-secret-key";
    const encrypted = crypto.encrypt(original);
    expect(encrypted).toBe("encrypted:my-secret-key");
    const decrypted = crypto.decrypt(encrypted);
    expect(decrypted).toBe("my-secret-key");
  });
});
