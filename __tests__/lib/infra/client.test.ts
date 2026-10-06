// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
import {
  truncateOutput,
  resolveConnectionConfig,
  generateSshKeyPair,
  createDirectory,
  statFile,
  readFileRaw,
  readFileHead,
  readFileForTransfer,
  writeFile,
  writeFileBuffer,
} from "@/lib/infra/client";

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

describe("generateSshKeyPair", () => {
  it("generates an ED25519 key pair", () => {
    const { privateKey, publicKey } = generateSshKeyPair();

    // Private key is OpenSSH format (compatible with ssh2/node-ssh)
    expect(privateKey).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(privateKey).toContain("-----END OPENSSH PRIVATE KEY-----");

    // Public key is authorized_keys format
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+\/=]+$/);
  });

  it("generates unique keys each time", () => {
    const key1 = generateSshKeyPair();
    const key2 = generateSshKeyPair();

    expect(key1.privateKey).not.toBe(key2.privateKey);
    expect(key1.publicKey).not.toBe(key2.publicKey);
  });

  it("public key has correct format for authorized_keys", () => {
    const { publicKey } = generateSshKeyPair();
    const parts = publicKey.split(" ");

    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("ssh-ed25519");

    // Base64 data decodes to OpenSSH binary format:
    // 4 bytes (length) + 11 bytes ("ssh-ed25519") + 4 bytes (length) + 32 bytes (key) = 51
    const base64Data = parts[1]!;
    const sshKeyData = Buffer.from(base64Data, "base64");
    expect(sshKeyData.length).toBe(51);

    // Verify the key type string is embedded correctly
    const keyTypeLen = sshKeyData.readUInt32BE(0);
    expect(keyTypeLen).toBe(11);
    expect(sshKeyData.slice(4, 15).toString()).toBe("ssh-ed25519");

    // Verify the raw key length
    const rawKeyLen = sshKeyData.readUInt32BE(15);
    expect(rawKeyLen).toBe(32);
  });

  it("public key base64 is valid", () => {
    const { publicKey } = generateSshKeyPair();
    const base64Data = publicKey.split(" ")[1]!;

    // Should be valid base64
    const decoded = Buffer.from(base64Data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
  });
});

describe("SFTP file operations", () => {
  const machine = {
    id: "machine-1",
    userId: "user-1",
    name: "test-server",
    host: "10.0.0.1",
    port: 22,
    username: "deploy",
    authMethod: "key",
    encryptedKey: "encrypted:-----BEGIN RSA PRIVATE KEY-----",
    encryptedPass: null,
    passPhrase: null,
  };

  interface FakeSftp {
    mkdir: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }

  /**
   * Stand up a NodeSSH whose SFTP session behaves like a real remote
   * filesystem holding `existingPaths`, and record what it is asked to do.
   */
  function setupSftp(
    existingPaths: string[],
    fileContent = "",
    statResult: { isDirectory: boolean; size: number } = { isDirectory: true, size: 42 },
  ) {
    const existing = new Set(existingPaths);
    const createdDirs: string[] = [];
    const written: { path: string; content: string | Buffer }[] = [];

    const sftp: FakeSftp = {
      mkdir: vi.fn((dirPath: string, cb: (err?: Error) => void) => {
        if (existing.has(dirPath)) {
          // Real servers report an existing directory as a plain SFTP failure.
          cb(Object.assign(new Error("Failure"), { code: 4 }));
          return;
        }
        existing.add(dirPath);
        createdDirs.push(dirPath);
        cb();
      }),
      stat: vi.fn((statPath: string, cb: (err: Error | undefined, stats?: unknown) => void) => {
        if (!existing.has(statPath)) {
          cb(Object.assign(new Error("No such file"), { code: 2 }));
          return;
        }
        cb(undefined, {
          isDirectory: () => statResult.isDirectory,
          isFile: () => !statResult.isDirectory,
          size: statResult.size,
          mtime: 1_700_000_000,
        });
      }),
      readFile: vi.fn((_path: string, cb: (err: Error | undefined, data?: Buffer) => void) => {
        cb(undefined, Buffer.from(fileContent, "utf8"));
      }),
      writeFile: vi.fn(
        (
          writePath: string,
          content: string | Buffer,
          encOrCb: string | ((err?: Error) => void),
          maybeCb?: (err?: Error) => void,
        ) => {
          // ssh2's writeFile takes an optional encoding before the callback for
          // string content; binary writes pass the callback third.
          const cb = typeof encOrCb === "function" ? encOrCb : maybeCb;
          written.push({ path: writePath, content });
          cb?.();
        },
      ),
      open: vi.fn((_openPath: string, _flags: string, cb: (err?: Error, handle?: Buffer) => void) =>
        cb(undefined, Buffer.from("handle")),
      ),
      read: vi.fn(
        (
          _handle: Buffer,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
          cb: (err?: Error, bytesRead?: number) => void,
        ) => {
          const source = Buffer.from(fileContent, "utf8");
          const chunk = source.subarray(position, position + length);
          chunk.copy(buffer, offset);
          cb(undefined, chunk.length);
        },
      ),
      close: vi.fn((_handle: Buffer, cb: (err?: Error) => void) => cb()),
    };

    (NodeSSH as unknown as Mock).mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        requestSFTP: vi.fn().mockResolvedValue(sftp),
        dispose: vi.fn(),
      };
    });

    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(machine);

    return { sftp, createdDirs, written };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates every missing parent, in order", async () => {
    const { createdDirs } = setupSftp(["/"]);

    await createDirectory("machine-1", "user-1", "/etc/new/nested/conf.d");

    expect(createdDirs).toEqual(["/etc", "/etc/new", "/etc/new/nested", "/etc/new/nested/conf.d"]);
  });

  it("does not fail when ancestors already exist", async () => {
    const { createdDirs } = setupSftp(["/", "/etc", "/etc/new"]);

    await createDirectory("machine-1", "user-1", "/etc/new/conf.d");

    expect(createdDirs).toEqual(["/etc/new/conf.d"]);
  });

  it("is a no-op for the root directory", async () => {
    const { sftp } = setupSftp(["/"]);

    await createDirectory("machine-1", "user-1", "/");

    expect(sftp.mkdir).not.toHaveBeenCalled();
  });

  it("surfaces a mkdir failure that is not an existing directory", async () => {
    const { sftp } = setupSftp([]);
    const denied = Object.assign(new Error("Permission denied"), { code: 3 });
    sftp.mkdir.mockImplementation((_path: string, cb: (err?: Error) => void) => cb(denied));

    await expect(createDirectory("machine-1", "user-1", "/root/secret")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("stats a remote path", async () => {
    setupSftp(["/etc/nginx.conf"]);

    const stats = await statFile("machine-1", "user-1", "/etc/nginx.conf");

    expect(stats.type).toBe("directory");
    expect(stats.size).toBe(42);
    expect(stats.modified.getTime()).toBe(1_700_000_000 * 1000);
  });

  it("throws when the path does not exist", async () => {
    setupSftp([]);

    await expect(statFile("machine-1", "user-1", "/etc/gone.conf")).rejects.toThrow("No such file");
  });

  it("reads a file without truncating it", async () => {
    const big = "x".repeat(120_000);
    setupSftp(["/var/log/big.log"], big);

    const buffer = await readFileRaw("machine-1", "user-1", "/var/log/big.log");

    expect(buffer.toString("utf8")).toHaveLength(120_000);
  });

  it("reads only the requested header bytes", async () => {
    const { sftp } = setupSftp(["/var/log/big.log"], "PNG-header-and-more");

    const head = await readFileHead("machine-1", "user-1", "/var/log/big.log", 9);

    expect(head.toString("utf8")).toBe("PNG-heade");
    expect(sftp.close).toHaveBeenCalled();
  });

  it("writes content through SFTP", async () => {
    const { written } = setupSftp(["/tmp"]);

    await writeFile("machine-1", "user-1", "/tmp/app.conf", "key = value\n");

    expect(written).toEqual([{ path: "/tmp/app.conf", content: "key = value\n" }]);
  });

  it("writes raw bytes through SFTP", async () => {
    const { written } = setupSftp(["/tmp"]);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    const result = await writeFileBuffer("machine-1", "user-1", "/tmp/logo.png", bytes);

    expect(result).toEqual({ ok: true, size: 6 });
    expect(written).toEqual([{ path: "/tmp/logo.png", content: bytes }]);
    // The bytes are preserved exactly, not re-encoded as text.
    expect((written[0]!.content as Buffer).equals(bytes)).toBe(true);
  });

  it("reads a file for transfer and reports its size", async () => {
    setupSftp(["/var/log/app.log"], "hello", { isDirectory: false, size: 5 });

    const { buffer, size } = await readFileForTransfer("machine-1", "user-1", "/var/log/app.log");

    expect(buffer.toString("utf8")).toBe("hello");
    expect(size).toBe(5);
  });

  it("rejects a directory before reading it", async () => {
    const { sftp } = setupSftp(["/var/log"], "", { isDirectory: true, size: 0 });

    await expect(readFileForTransfer("machine-1", "user-1", "/var/log")).rejects.toThrow(
      /is a directory, not a file/,
    );
    expect(sftp.readFile).not.toHaveBeenCalled();
  });

  it("refuses an oversize file before reading it", async () => {
    const { sftp } = setupSftp(["/var/log/huge.log"], "xxxxxxxxxx", {
      isDirectory: false,
      size: 100,
    });

    await expect(
      readFileForTransfer("machine-1", "user-1", "/var/log/huge.log", 10),
    ).rejects.toThrow(/over the 10 bytes transfer limit/);
    expect(sftp.readFile).not.toHaveBeenCalled();
  });

  it("scopes the connection to the authenticated user", async () => {
    setupSftp(["/etc/nginx.conf"]);

    await statFile("machine-1", "user-1", "/etc/nginx.conf");

    expect(mockInfraMachine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "machine-1", userId: "user-1" } }),
    );
  });
});
