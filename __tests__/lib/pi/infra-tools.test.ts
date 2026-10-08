// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    infraMachine: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    infraNote: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock crypto
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((input: string) => `encrypted:${input}`),
}));

// Mock infra client
vi.mock("@/lib/infra/client", () => ({
  executeCommand: vi.fn(),
  readFileRaw: vi.fn(),
  readFileHead: vi.fn(),
  readFileForTransfer: vi.fn(),
  writeFile: vi.fn(),
  writeFileBuffer: vi.fn(),
  statFile: vi.fn(),
  createDirectory: vi.fn(),
  MAX_TRANSFER_BYTES: 50 * 1024 * 1024,
  formatBytes: (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`,
  generateSshKeyPair: vi.fn(() => ({
    privateKey:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nmock-private-key\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyData",
  })),
}));

// Mock terminal client (the agent workspace a transfer lands in)
vi.mock("@/lib/terminal/client", () => ({
  isConfigured: vi.fn(() => true),
  getTerminalHomeDir: vi.fn(() => "/home/deploy"),
  listDirectory: vi.fn(),
  readFileBinary: vi.fn(),
  uploadFile: vi.fn(),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import * as client from "@/lib/infra/client";
import * as terminal from "@/lib/terminal/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInfraMachine = db.prisma.infraMachine as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInfraNote = db.prisma.infraNote as any;

// Import after mocks
import { createInfraTools } from "@/lib/pi/tools/infra-tools";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

// Helper to parse the first JSON object from tool result text
// (tools append _saaleInfraMeta JSON after a newline, so we extract just the first block)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseResult = (text: string): any => {
  const metaIdx = text.indexOf('{"_saaleInfraMeta"');
  if (metaIdx === -1) return JSON.parse(text);

  // Walk forward to find the end of the first JSON object (depth returns to 0)
  let depth = 0;
  let endIdx = -1;
  for (let i = 0; i < metaIdx; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return JSON.parse(text.trim());
  return JSON.parse(text.slice(0, endIdx + 1));
};

// Helper to extract the `_saaleInfraMeta` block from a tool result text
const parseMeta = (text: string): Record<string, unknown> => {
  const metaIdx = text.indexOf('{"_saaleInfraMeta"');
  if (metaIdx === -1) throw new Error("no _saaleInfraMeta in result text");
  return (JSON.parse(text.slice(metaIdx)) as { _saaleInfraMeta: Record<string, unknown> })
    ._saaleInfraMeta;
};

// Shared context for tool lookups
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = {};

describe("createInfraTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();

    const tools = createInfraTools(userId);
    ctx.tools = tools;
    ctx.listMachines = tools.find((t: { name: string }) => t.name === "infra_list_machines")!;
    ctx.addMachine = tools.find((t: { name: string }) => t.name === "infra_add_machine")!;
    ctx.removeMachine = tools.find((t: { name: string }) => t.name === "infra_remove_machine")!;
    ctx.exec = tools.find((t: { name: string }) => t.name === "infra_exec")!;
    ctx.readFile = tools.find((t: { name: string }) => t.name === "infra_read_file")!;
    ctx.writeFile = tools.find((t: { name: string }) => t.name === "infra_write_file")!;
    ctx.editFile = tools.find((t: { name: string }) => t.name === "infra_edit_file")!;
    ctx.downloadFile = tools.find((t: { name: string }) => t.name === "infra_download_file")!;
    ctx.uploadFile = tools.find((t: { name: string }) => t.name === "infra_upload_file")!;
    ctx.notesList = tools.find((t: { name: string }) => t.name === "infra_notes_list")!;
    ctx.notesGet = tools.find((t: { name: string }) => t.name === "infra_notes_get")!;
    ctx.notesUpsert = tools.find((t: { name: string }) => t.name === "infra_notes_upsert")!;
    ctx.notesDelete = tools.find((t: { name: string }) => t.name === "infra_notes_delete")!;
  });

  it("returns all 13 expected tools", () => {
    const names = ctx.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("infra_list_machines");
    expect(names).toContain("infra_add_machine");
    expect(names).toContain("infra_remove_machine");
    expect(names).toContain("infra_exec");
    expect(names).toContain("infra_read_file");
    expect(names).toContain("infra_write_file");
    expect(names).toContain("infra_edit_file");
    expect(names).toContain("infra_download_file");
    expect(names).toContain("infra_upload_file");
    expect(names).toContain("infra_notes_list");
    expect(names).toContain("infra_notes_get");
    expect(names).toContain("infra_notes_upsert");
    expect(names).toContain("infra_notes_delete");
    expect(names).toHaveLength(13);
  });

  // Tool descriptions are prompt surface for every session type (chat, Telegram
  // and agent jobs, which supply their own system prompt). The note-hygiene
  // contract must travel with the tools, not only in the shared system prompt.
  describe("note prompting contract", () => {
    it("upsert requires listing first and updating by id, not duplicating", () => {
      const desc = ctx.notesUpsert.description;
      expect(desc).toContain("infra_notes_list");
      expect(desc).toContain("id");
      expect(desc.toLowerCase()).toContain("duplicate");
    });

    it("upsert restricts notes to present-state facts", () => {
      const desc = ctx.notesUpsert.description;
      expect(desc).toContain("right now");
      expect(desc).toContain("never plans");
      expect(desc.toLowerCase()).toContain("change on their own");
    });

    it("list reads notes as durable state before writing", () => {
      const desc = ctx.notesList.description;
      expect(desc).toContain("durable record");
      expect(desc.toLowerCase()).toContain("duplicate");
    });

    it("delete is framed as removing stale notes", () => {
      expect(ctx.notesDelete.description.toLowerCase()).toContain("stale");
    });
  });

  describe("infra_list_machines", () => {
    it("returns empty list when no machines exist", async () => {
      vi.mocked(mockInfraMachine.findMany).mockResolvedValue([]);

      const result = await callExecute(ctx.listMachines.execute, {});
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(0);
      expect(text.machines).toHaveLength(0);
      expect(mockInfraMachine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-123" },
        }),
      );
    });

    it("returns machines scoped to userId", async () => {
      vi.mocked(mockInfraMachine.findMany).mockResolvedValue([
        {
          id: "m1",
          name: "web-01",
          host: "10.0.0.1",
          port: 22,
          username: "deploy",
          authMethod: "key",
          createdAt: new Date("2025-01-01"),
          notes: [],
        },
      ]);

      const result = await callExecute(ctx.listMachines.execute, {});
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(1);
      expect(text.machines[0].id).toBe("m1");
      expect(text.machines[0].noteCount).toBe(0);
    });

    it("includes note count from relation", async () => {
      vi.mocked(mockInfraMachine.findMany).mockResolvedValue([
        {
          id: "m1",
          name: "web-01",
          host: "10.0.0.1",
          port: 22,
          username: "deploy",
          authMethod: "key",
          createdAt: new Date("2025-01-01"),
          notes: [
            { id: "n1", title: "services", category: "services" },
            { id: "n2", title: "paths", category: "paths" },
          ],
        },
      ]);

      const result = await callExecute(ctx.listMachines.execute, {});
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.machines[0].noteCount).toBe(2);
    });
  });

  describe("infra_add_machine", () => {
    it("creates machine with key auth and returns public key", async () => {
      vi.mocked(mockInfraMachine.create).mockResolvedValue({
        id: "new-machine",
        name: "prod-web",
        host: "10.0.0.1",
        port: 22,
        username: "deploy",
        authMethod: "key",
        createdAt: new Date(),
      });

      const result = await callExecute(ctx.addMachine.execute, {
        name: "prod-web",
        host: "10.0.0.1",
        port: 22,
        username: "deploy",
        authMethod: "key",
      });

      const text = parseResult((result.content[0] as { type: string; text: string }).text);
      expect(text.added).toBe(true);
      expect(text.machine.id).toBe("new-machine");

      // Key pair was generated
      expect(client.generateSshKeyPair).toHaveBeenCalled();

      // Private key was encrypted and stored
      expect(crypto.encrypt).toHaveBeenCalledWith(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nmock-private-key\n-----END OPENSSH PRIVATE KEY-----",
      );

      // Public key is returned for authorized_keys setup
      expect(text.authorizedKeysEntry).toBe(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyData",
      );

      // Setup instructions included
      expect(text.setupInstructions).toContain("authorized_keys");
      expect(text.setupInstructions).toContain("10.0.0.1");

      // Verify userId was passed
      expect(mockInfraMachine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: "user-123" }),
        }),
      );
    });

    it("creates machine with password auth", async () => {
      vi.mocked(mockInfraMachine.create).mockResolvedValue({
        id: "new-machine",
        name: "home-server",
        host: "192.168.1.100",
        port: 22,
        username: "admin",
        authMethod: "password",
        createdAt: new Date(),
      });

      const result = await callExecute(ctx.addMachine.execute, {
        name: "home-server",
        host: "192.168.1.100",
        username: "admin",
        authMethod: "password",
        password: "mypassword",
      });

      const text = parseResult((result.content[0] as { type: string; text: string }).text);
      expect(text.added).toBe(true);
      expect(crypto.encrypt).toHaveBeenCalledWith("mypassword");
      expect(text.authorizedKeysEntry).toBeUndefined();
    });

    it("uses default port 22 when not specified", async () => {
      vi.mocked(mockInfraMachine.create).mockResolvedValue({
        id: "new-machine",
        name: "test",
        host: "10.0.0.1",
        port: 22,
        username: "deploy",
        authMethod: "key",
        createdAt: new Date(),
      });

      await callExecute(ctx.addMachine.execute, {
        name: "test",
        host: "10.0.0.1",
        username: "deploy",
        authMethod: "key",
      });

      expect(mockInfraMachine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ port: 22 }),
        }),
      );
    });

    it("uses custom port when specified", async () => {
      vi.mocked(mockInfraMachine.create).mockResolvedValue({
        id: "new-machine",
        name: "test",
        host: "10.0.0.1",
        port: 2222,
        username: "deploy",
        authMethod: "key",
        createdAt: new Date(),
      });

      await callExecute(ctx.addMachine.execute, {
        name: "test",
        host: "10.0.0.1",
        port: 2222,
        username: "deploy",
        authMethod: "key",
      });

      expect(mockInfraMachine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ port: 2222 }),
        }),
      );
    });

    it("throws when password auth missing password", async () => {
      await expect(
        callExecute(ctx.addMachine.execute, {
          name: "test",
          host: "10.0.0.1",
          username: "deploy",
          authMethod: "password",
        }),
      ).rejects.toThrow("password is required when authMethod='password'");
    });
  });

  describe("infra_remove_machine", () => {
    it("removes machine scoped to userId", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        userId: "user-123",
        name: "prod-web",
      });
      vi.mocked(mockInfraMachine.delete).mockResolvedValue({});

      const result = await callExecute(ctx.removeMachine.execute, { id: "m1" });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.removed).toBe(true);
      expect(text.id).toBe("m1");
      expect(text.name).toBe("prod-web");

      // Verify delete is scoped to userId
      expect(mockInfraMachine.delete).toHaveBeenCalledWith({
        where: { id: "m1", userId: "user-123" },
      });
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.removeMachine.execute, { id: "nonexistent" })).rejects.toThrow(
        "Machine nonexistent not found",
      );
    });

    it("throws when machine belongs to another user", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.removeMachine.execute, { id: "other-user-machine" }),
      ).rejects.toThrow("Machine other-user-machine not found");
    });
  });

  describe("infra_exec", () => {
    it("executes command with default timeout", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.executeCommand).mockResolvedValue({
        stdout: "hello world",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      });

      const result = await callExecute(ctx.exec.execute, {
        id: "m1",
        command: "echo hello",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.exitCode).toBe(0);
      expect(text.stdout).toBe("hello world");
      expect(client.executeCommand).toHaveBeenCalledWith("m1", "user-123", "echo hello", {
        timeout: 30,
      });

      // A script gets the command's result as fields, and none of the card the
      // console draws: a marker it greps for can no longer match its own query.
      expect(result.structuredContent).toMatchObject({
        machine: "prod-web",
        command: "echo hello",
        exitCode: 0,
        stdout: "hello world",
        signal: null,
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("_saaleInfraMeta");
    });

    it("passes custom timeout", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.executeCommand).mockResolvedValue({
        stdout: "done",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      });

      await callExecute(ctx.exec.execute, {
        id: "m1",
        command: "npm install",
        timeout: 120,
      });

      expect(client.executeCommand).toHaveBeenCalledWith("m1", "user-123", "npm install", {
        timeout: 120,
      });
    });

    it("passes cwd when specified", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.executeCommand).mockResolvedValue({
        stdout: "output",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      });

      await callExecute(ctx.exec.execute, {
        id: "m1",
        command: "ls",
        cwd: "/var/www",
      });

      expect(client.executeCommand).toHaveBeenCalledWith("m1", "user-123", "ls", {
        timeout: 30,
        cwd: "/var/www",
      });
    });

    it("reports timeout correctly", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "Command timed out after 30s. Increase the timeout parameter for longer commands.",
        exitCode: null,
        signal: null,
        timedOut: true,
        truncated: false,
      });

      const result = await callExecute(ctx.exec.execute, {
        id: "m1",
        command: "sleep 1000",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.timedOut).toBe(true);
      expect(text.exitCode).toBeNull();
    });

    it("reports truncated output", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.executeCommand).mockResolvedValue({
        stdout: "very long output\n\n[output truncated — exceeded 51200 byte limit]",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: true,
      });

      const result = await callExecute(ctx.exec.execute, {
        id: "m1",
        command: "cat /var/log/syslog",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.truncated).toBe(true);
    });

    it("throws when command is empty", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });

      await expect(
        callExecute(ctx.exec.execute, {
          id: "m1",
          command: "",
        }),
      ).rejects.toThrow("command must not be empty");
    });

    it("throws when command is whitespace only", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });

      await expect(
        callExecute(ctx.exec.execute, {
          id: "m1",
          command: "   ",
        }),
      ).rejects.toThrow("command must not be empty");
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.exec.execute, {
          id: "nonexistent",
          command: "echo hello",
        }),
      ).rejects.toThrow("Machine nonexistent not found");
    });
  });

  describe("infra_read_file", () => {
    /** The text of the (single) text block Pi's read tool returned. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultText = (result: any): string =>
      (result.content as { type: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");

    const FILE = "server {\n  listen 80;\n  root /var/www;\n}\n";

    beforeEach(() => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ id: "m1", name: "prod-web" });
      vi.mocked(client.statFile).mockResolvedValue({
        type: "file",
        size: FILE.length,
        modified: new Date("2025-01-01"),
      });
      // Head sniff: not an image.
      vi.mocked(client.readFileHead).mockResolvedValue(Buffer.from("server {", "utf8"));
      vi.mocked(client.readFileRaw).mockResolvedValue(Buffer.from(FILE, "utf8"));
    });

    it("returns the file content Pi read from the machine", async () => {
      const result = await callExecute(ctx.readFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
      });

      expect(resultText(result)).toContain("  listen 80;");
      expect(client.readFileRaw).toHaveBeenCalledWith("m1", "user-123", "/etc/nginx/nginx.conf");
      expect(client.statFile).toHaveBeenCalledWith("m1", "user-123", "/etc/nginx/nginx.conf");
      expect(parseMeta(resultText(result))).toMatchObject({
        type: "infra_read_file",
        machineName: "prod-web",
        path: "/etc/nginx/nginx.conf",
        truncated: false,
        preview: FILE.slice(0, 200),
      });
    });

    it("pages through a large file with offset and limit", async () => {
      const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
      vi.mocked(client.readFileRaw).mockResolvedValue(Buffer.from(lines.join("\n"), "utf8"));

      const result = await callExecute(ctx.readFile.execute, {
        id: "m1",
        path: "/var/log/app.log",
        offset: 2,
        limit: 2,
      });
      const text = resultText(result);

      expect(text).toContain("line 2");
      expect(text).toContain("line 3");
      expect(text).not.toContain("line 1\n");
      expect(text).not.toContain("line 4");
      expect(text).toContain("2 more lines in file. Use offset=4 to continue.");
    });

    it("reports truncation for a file over the line limit", async () => {
      const lines = Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`);
      vi.mocked(client.readFileRaw).mockResolvedValue(Buffer.from(lines.join("\n"), "utf8"));

      const result = await callExecute(ctx.readFile.execute, {
        id: "m1",
        path: "/var/log/huge.log",
      });
      const text = resultText(result);

      expect(text).toContain("Use offset=");
      expect(parseMeta(text)).toMatchObject({
        type: "infra_read_file",
        machineName: "prod-web",
        path: "/var/log/huge.log",
        truncated: true,
        totalLines: 2100,
      });
    });

    it("sends a remote image as an attachment", async () => {
      // 1x1 PNG, the same fixture the attachment tests use.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      vi.mocked(client.readFileHead).mockResolvedValue(png);
      vi.mocked(client.readFileRaw).mockResolvedValue(png);

      const result = await callExecute(ctx.readFile.execute, {
        id: "m1",
        path: "/var/www/logo.png",
      });

      const content = result.content as { type: string; mimeType?: string }[];
      expect(content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
      );
      expect(resultText(result)).toContain("Read image file [image/png]");
      expect(parseMeta(resultText(result))).toMatchObject({
        type: "infra_read_file",
        imageMimeType: "image/png",
      });
      expect(client.readFileHead).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/var/www/logo.png",
        expect.any(Number),
      );
    });

    it("rejects a relative path instead of resolving it against the host", async () => {
      await expect(
        callExecute(ctx.readFile.execute, { id: "m1", path: "etc/nginx/nginx.conf" }),
      ).rejects.toThrow(/path must be absolute/);
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });

    it("reports a missing file as missing, not as an SFTP status code", async () => {
      vi.mocked(client.statFile).mockRejectedValue(
        Object.assign(new Error("No such file"), { code: 2 }),
      );

      await expect(
        callExecute(ctx.readFile.execute, { id: "m1", path: "/etc/gone.conf" }),
      ).rejects.toThrow(/\/etc\/gone\.conf does not exist or cannot be read/);
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.readFile.execute, { id: "nonexistent", path: "/etc/hosts" }),
      ).rejects.toThrow("Machine nonexistent not found");
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });
  });

  describe("infra_write_file", () => {
    const FILE = "server {\n  listen 80;\n}\n";

    it("writes file via SFTP", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.writeFile).mockResolvedValue({ ok: true });

      const result = await callExecute(ctx.writeFile.execute, {
        id: "m1",
        path: "/tmp/test.txt",
        content: "hello world",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.ok).toBe(true);
      expect(client.writeFile).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/tmp/test.txt",
        "hello world",
      );
    });

    it("creates the parent directory before writing", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.writeFile).mockResolvedValue({ ok: true });

      await callExecute(ctx.writeFile.execute, {
        id: "m1",
        path: "/etc/new/nested/conf.d/app.conf",
        content: FILE,
      });

      expect(client.createDirectory).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/new/nested/conf.d",
      );
      expect(client.writeFile).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/new/nested/conf.d/app.conf",
        FILE,
      );
    });

    it("does not try to create a root-level parent", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.writeFile).mockResolvedValue({ ok: true });

      await callExecute(ctx.writeFile.execute, {
        id: "m1",
        path: "/app.conf",
        content: FILE,
      });

      expect(client.createDirectory).not.toHaveBeenCalled();
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.writeFile.execute, {
          id: "nonexistent",
          path: "/tmp/test.txt",
          content: "hello",
        }),
      ).rejects.toThrow("Machine nonexistent not found");
      expect(client.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("infra_edit_file", () => {
    const CONF = "server {\n  listen 80;\n  root /var/www;\n}\n";

    beforeEach(() => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(client.statFile).mockResolvedValue({
        type: "file",
        size: CONF.length,
        modified: new Date("2025-01-01"),
      });
      vi.mocked(client.readFileRaw).mockResolvedValue(Buffer.from(CONF, "utf8"));
      vi.mocked(client.writeFile).mockResolvedValue({ ok: true });
    });

    it("replaces matching text and writes the whole file back", async () => {
      const result = await callExecute(ctx.editFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
        edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
      });
      const raw = (result.content[0] as { type: string; text: string }).text;

      expect(client.writeFile).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/nginx/nginx.conf",
        "server {\n  listen 8080;\n  root /var/www;\n}\n",
      );

      const text = parseResult(raw);
      expect(text.machine).toBe("prod-web");
      expect(text.replacements).toBe(1);
      expect(text.diff).toMatch(/^-.*listen 80;/m);
      expect(text.diff).toMatch(/^\+.*listen 8080;/m);
      expect(parseMeta(raw)).toMatchObject({
        type: "infra_edit_file",
        machineName: "prod-web",
        path: "/etc/nginx/nginx.conf",
        replacements: 1,
      });
    });

    it("reads the file untruncated so the write-back cannot lose the tail", async () => {
      await callExecute(ctx.editFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
        edits: [{ oldText: "root /var/www;", newText: "root /srv/www;" }],
      });

      expect(client.readFileRaw).toHaveBeenCalledWith("m1", "user-123", "/etc/nginx/nginx.conf");
      // A truncated read would be written back as a truncated file.
      expect(vi.mocked(client.writeFile).mock.calls[0]?.[3]).toContain("root /srv/www;\n}\n");
    });

    it("applies several edits from one call against the original content", async () => {
      await callExecute(ctx.editFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
        edits: [
          { oldText: "listen 80;", newText: "listen 8080;" },
          { oldText: "root /var/www;", newText: "root /srv/www;" },
        ],
      });

      expect(client.writeFile).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/nginx/nginx.conf",
        "server {\n  listen 8080;\n  root /srv/www;\n}\n",
      );
    });

    it("preserves CRLF line endings", async () => {
      const crlf = "key=value\r\nother=1\r\n";
      vi.mocked(client.readFileRaw).mockResolvedValue(Buffer.from(crlf, "utf8"));

      await callExecute(ctx.editFile.execute, {
        id: "m1",
        path: "/etc/app.conf",
        edits: [{ oldText: "other=1", newText: "other=2" }],
      });

      expect(client.writeFile).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/app.conf",
        "key=value\r\nother=2\r\n",
      );
    });

    it("rejects text that is not unique in the file", async () => {
      vi.mocked(client.readFileRaw).mockResolvedValue(
        Buffer.from("a = 1;\nb = 1;\na = 1;\n", "utf8"),
      );

      await expect(
        callExecute(ctx.editFile.execute, {
          id: "m1",
          path: "/etc/app.conf",
          edits: [{ oldText: "a = 1;", newText: "a = 2;" }],
        }),
      ).rejects.toThrow(/2 occurrences/);
      expect(client.writeFile).not.toHaveBeenCalled();
    });

    it("rejects oldText that does not appear in the file", async () => {
      await expect(
        callExecute(ctx.editFile.execute, {
          id: "m1",
          path: "/etc/nginx/nginx.conf",
          edits: [{ oldText: "listen 9999;", newText: "listen 8080;" }],
        }),
      ).rejects.toThrow(/Could not find the exact text/);
      expect(client.writeFile).not.toHaveBeenCalled();
    });

    it("rejects a relative path instead of resolving it against the host", async () => {
      await expect(
        callExecute(ctx.editFile.execute, {
          id: "m1",
          path: "etc/nginx/nginx.conf",
          edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
        }),
      ).rejects.toThrow(/path must be absolute/);
      expect(client.statFile).not.toHaveBeenCalled();
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });

    it("rejects a path that is a directory", async () => {
      vi.mocked(client.statFile).mockResolvedValue({
        type: "directory",
        size: 4096,
        modified: new Date("2025-01-01"),
      });

      await expect(
        callExecute(ctx.editFile.execute, {
          id: "m1",
          path: "/etc/nginx",
          edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
        }),
      ).rejects.toThrow(/is a directory, not a file/);
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });

    it("reports a missing file as missing, not as an SFTP status code", async () => {
      vi.mocked(client.statFile).mockRejectedValue(
        Object.assign(new Error("No such file"), { code: 2 }),
      );

      await expect(
        callExecute(ctx.editFile.execute, {
          id: "m1",
          path: "/etc/gone.conf",
          edits: [{ oldText: "a", newText: "b" }],
        }),
      ).rejects.toThrow(/\/etc\/gone\.conf does not exist or cannot be read/);
      expect(client.writeFile).not.toHaveBeenCalled();
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.editFile.execute, {
          id: "nonexistent",
          path: "/etc/nginx/nginx.conf",
          edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
        }),
      ).rejects.toThrow("Machine nonexistent not found");
      expect(client.readFileRaw).not.toHaveBeenCalled();
    });

    it("scopes the machine lookup to the authenticated user", async () => {
      await callExecute(ctx.editFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
        edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
      });

      expect(mockInfraMachine.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "m1", userId: "user-123" },
        }),
      );
    });

    it("edits sequentially so the machine hand-off cannot be interleaved", () => {
      expect(ctx.editFile.executionMode).toBe("sequential");
    });
  });

  describe("infra_download_file", () => {
    beforeEach(() => {
      vi.mocked(terminal.isConfigured).mockReturnValue(true);
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ id: "m1", name: "prod-web" });
      vi.mocked(client.readFileForTransfer).mockResolvedValue({
        buffer: Buffer.from("server {}\n", "utf8"),
        size: 11,
      });
      vi.mocked(terminal.uploadFile).mockImplementation(async (fileName, _content, options) => ({
        path: `${options.directory}/${fileName}`,
        size: 11,
      }));
    });

    it("pulls a remote file into the workspace root by default", async () => {
      const result = await callExecute(ctx.downloadFile.execute, {
        id: "m1",
        path: "/etc/nginx/nginx.conf",
      });
      const text = (result.content as { type: string; text: string }[])[0]!.text;

      expect(client.readFileForTransfer).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/etc/nginx/nginx.conf",
      );
      expect(terminal.uploadFile).toHaveBeenCalledWith(
        "nginx.conf",
        expect.any(Buffer),
        expect.objectContaining({ directory: "/home/deploy", userId: "user-123" }),
      );
      expect(parseResult(text)).toMatchObject({
        machine: "prod-web",
        remotePath: "/etc/nginx/nginx.conf",
        localPath: "/home/deploy/nginx.conf",
        size: 11,
        downloaded: true,
      });
      expect(parseMeta(text)).toMatchObject({
        type: "infra_download_file",
        machineId: "m1",
        machineName: "prod-web",
        path: "/etc/nginx/nginx.conf",
        localPath: "/home/deploy/nginx.conf",
        size: 11,
      });
    });

    it("writes to a nested destination when one is given", async () => {
      await callExecute(ctx.downloadFile.execute, {
        id: "m1",
        path: "/var/log/app.log",
        dest: "downloads/app.log",
      });

      expect(terminal.uploadFile).toHaveBeenCalledWith(
        "app.log",
        expect.any(Buffer),
        expect.objectContaining({ directory: "/home/deploy/downloads" }),
      );
    });

    it("rejects a relative remote path", async () => {
      await expect(
        callExecute(ctx.downloadFile.execute, { id: "m1", path: "etc/nginx.conf" }),
      ).rejects.toThrow(/path must be absolute/);
      expect(client.readFileForTransfer).not.toHaveBeenCalled();
    });

    it("refuses a destination that escapes the workspace", async () => {
      await expect(
        callExecute(ctx.downloadFile.execute, {
          id: "m1",
          path: "/etc/passwd",
          dest: "../../etc/passwd-copy",
        }),
      ).rejects.toThrow(/outside the workspace/);
      expect(client.readFileForTransfer).not.toHaveBeenCalled();
    });

    it("throws when the terminal workspace is not configured", async () => {
      vi.mocked(terminal.isConfigured).mockReturnValue(false);

      await expect(
        callExecute(ctx.downloadFile.execute, { id: "m1", path: "/etc/hosts" }),
      ).rejects.toThrow(/Terminal workspace/);
      expect(client.readFileForTransfer).not.toHaveBeenCalled();
    });

    it("surfaces an oversize file from the transfer read", async () => {
      vi.mocked(client.readFileForTransfer).mockRejectedValue(
        new Error("/var/log/huge.log is 200.0MB, over the 50.0MB transfer limit"),
      );

      await expect(
        callExecute(ctx.downloadFile.execute, { id: "m1", path: "/var/log/huge.log" }),
      ).rejects.toThrow(/transfer limit/);
      expect(terminal.uploadFile).not.toHaveBeenCalled();
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.downloadFile.execute, { id: "nope", path: "/etc/hosts" }),
      ).rejects.toThrow("Machine nope not found");
      expect(client.readFileForTransfer).not.toHaveBeenCalled();
    });
  });

  describe("infra_upload_file", () => {
    beforeEach(() => {
      vi.mocked(terminal.isConfigured).mockReturnValue(true);
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ id: "m1", name: "prod-web" });
      vi.mocked(terminal.listDirectory).mockResolvedValue({
        dir: "/home/deploy",
        entries: [{ name: "report.txt", type: "file", size: 12, modified: 0 }],
      });
      vi.mocked(terminal.readFileBinary).mockResolvedValue({
        path: "/home/deploy/report.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello world\n", "utf8"),
      });
      vi.mocked(client.writeFileBuffer).mockResolvedValue({ ok: true, size: 12 });
      vi.mocked(client.createDirectory).mockResolvedValue({ ok: true });
    });

    it("sends a workspace file to the machine, creating its parent", async () => {
      const result = await callExecute(ctx.uploadFile.execute, {
        id: "m1",
        source: "report.txt",
        path: "/var/www/report.txt",
      });
      const text = (result.content as { type: string; text: string }[])[0]!.text;

      expect(terminal.readFileBinary).toHaveBeenCalledWith("/home/deploy/report.txt", {
        userId: "user-123",
      });
      expect(client.createDirectory).toHaveBeenCalledWith("m1", "user-123", "/var/www");
      expect(client.writeFileBuffer).toHaveBeenCalledWith(
        "m1",
        "user-123",
        "/var/www/report.txt",
        expect.any(Buffer),
      );
      expect(parseResult(text)).toMatchObject({
        machine: "prod-web",
        localPath: "/home/deploy/report.txt",
        remotePath: "/var/www/report.txt",
        size: 12,
        uploaded: true,
      });
      expect(parseMeta(text)).toMatchObject({
        type: "infra_upload_file",
        machineId: "m1",
        machineName: "prod-web",
        path: "/var/www/report.txt",
        localPath: "/home/deploy/report.txt",
        size: 12,
      });
    });

    it("does not try to create a root-level parent", async () => {
      await callExecute(ctx.uploadFile.execute, {
        id: "m1",
        source: "report.txt",
        path: "/report.txt",
      });

      expect(client.createDirectory).not.toHaveBeenCalled();
      expect(client.writeFileBuffer).toHaveBeenCalled();
    });

    it("rejects a relative remote path", async () => {
      await expect(
        callExecute(ctx.uploadFile.execute, { id: "m1", source: "report.txt", path: "www/x" }),
      ).rejects.toThrow(/path must be absolute/);
      expect(client.writeFileBuffer).not.toHaveBeenCalled();
    });

    it("refuses a source that escapes the workspace", async () => {
      await expect(
        callExecute(ctx.uploadFile.execute, {
          id: "m1",
          source: "../../etc/shadow",
          path: "/tmp/shadow",
        }),
      ).rejects.toThrow(/outside the workspace/);
      expect(terminal.readFileBinary).not.toHaveBeenCalled();
    });

    it("refuses a source that does not exist", async () => {
      vi.mocked(terminal.listDirectory).mockResolvedValue({ dir: "/home/deploy", entries: [] });

      await expect(
        callExecute(ctx.uploadFile.execute, { id: "m1", source: "gone.txt", path: "/tmp/x" }),
      ).rejects.toThrow(/does not exist in the workspace/);
      expect(client.writeFileBuffer).not.toHaveBeenCalled();
    });

    it("refuses a source that is a directory", async () => {
      vi.mocked(terminal.listDirectory).mockResolvedValue({
        dir: "/home/deploy",
        entries: [{ name: "stuff", type: "directory", size: 0, modified: 0 }],
      });

      await expect(
        callExecute(ctx.uploadFile.execute, { id: "m1", source: "stuff", path: "/tmp/x" }),
      ).rejects.toThrow(/is a directory, not a file/);
      expect(client.writeFileBuffer).not.toHaveBeenCalled();
    });

    it("refuses a file over the transfer limit before reading it", async () => {
      vi.mocked(terminal.listDirectory).mockResolvedValue({
        dir: "/home/deploy",
        entries: [{ name: "big.iso", type: "file", size: 200 * 1024 * 1024, modified: 0 }],
      });

      await expect(
        callExecute(ctx.uploadFile.execute, { id: "m1", source: "big.iso", path: "/tmp/big.iso" }),
      ).rejects.toThrow(/transfer limit/);
      expect(terminal.readFileBinary).not.toHaveBeenCalled();
    });

    it("throws when the terminal workspace is not configured", async () => {
      vi.mocked(terminal.isConfigured).mockReturnValue(false);

      await expect(
        callExecute(ctx.uploadFile.execute, { id: "m1", source: "report.txt", path: "/tmp/x" }),
      ).rejects.toThrow(/Terminal workspace/);
      expect(client.writeFileBuffer).not.toHaveBeenCalled();
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.uploadFile.execute, { id: "nope", source: "report.txt", path: "/tmp/x" }),
      ).rejects.toThrow("Machine nope not found");
      expect(client.writeFileBuffer).not.toHaveBeenCalled();
    });
  });

  describe("infra_notes_list", () => {
    it("lists all notes for a machine", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.findMany).mockResolvedValue([
        {
          id: "n1",
          title: "nginx config",
          category: "config",
          content: "nginx runs on port 80",
          updatedAt: new Date("2025-01-01"),
        },
        {
          id: "n2",
          title: "ssh quirks",
          category: "quirks",
          content: "uses port 2222",
          updatedAt: new Date("2025-01-02"),
        },
      ]);

      const result = await callExecute(ctx.notesList.execute, { id: "m1" });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(2);
      expect(text.notes[0].category).toBe("config");
      expect(text.notes[1].category).toBe("quirks");
    });

    it("filters by category", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.findMany).mockResolvedValue([
        {
          id: "n1",
          title: "nginx config",
          category: "config",
          content: "nginx runs on port 80",
          updatedAt: new Date(),
        },
      ]);

      await callExecute(ctx.notesList.execute, {
        id: "m1",
        category: "config",
      });

      expect(mockInfraNote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: "config" }),
        }),
      );
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.notesList.execute, { id: "nonexistent" })).rejects.toThrow(
        "Machine nonexistent not found",
      );
    });
  });

  describe("infra_notes_get", () => {
    it("returns note content with machine info", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue({
        id: "n1",
        title: "nginx config",
        category: "config",
        content: "nginx runs on port 80",
        updatedAt: new Date("2025-01-01"),
        machine: { userId: "user-123", name: "prod-web" },
      });

      const result = await callExecute(ctx.notesGet.execute, { id: "n1" });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.machine).toBe("prod-web");
      expect(text.note.content).toBe("nginx runs on port 80");
      expect(text.note.category).toBe("config");
    });

    it("throws when note not found", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.notesGet.execute, { id: "nonexistent" })).rejects.toThrow(
        "Note nonexistent not found",
      );
    });

    it("throws when note belongs to another user", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue({
        id: "n1",
        machine: { userId: "other-user", name: "other-machine" },
      });

      await expect(callExecute(ctx.notesGet.execute, { id: "n1" })).rejects.toThrow(
        "Note n1 not found",
      );
    });
  });

  describe("infra_notes_upsert", () => {
    it("creates new note with default category", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.create).mockResolvedValue({
        id: "new-note",
        title: "service info",
        category: "general",
        updatedAt: new Date(),
      });

      const result = await callExecute(ctx.notesUpsert.execute, {
        machineId: "m1",
        title: "service info",
        content: "nginx and postgres",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.note.id).toBe("new-note");
      expect(text.note.category).toBe("general");
      expect(mockInfraNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ machineId: "m1" }),
        }),
      );
    });

    it("creates note with custom category", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.create).mockResolvedValue({
        id: "new-note",
        title: "service info",
        category: "services",
        updatedAt: new Date(),
      });

      await callExecute(ctx.notesUpsert.execute, {
        machineId: "m1",
        title: "service info",
        content: "nginx and postgres",
        category: "services",
      });

      expect(mockInfraNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: "services" }),
        }),
      );
    });

    it("updates existing note", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue({
        id: "n1",
        machineId: "m1",
      });
      vi.mocked(mockInfraNote.update).mockResolvedValue({
        id: "n1",
        title: "updated title",
        category: "services",
        updatedAt: new Date(),
      });

      const result = await callExecute(ctx.notesUpsert.execute, {
        machineId: "m1",
        id: "n1",
        title: "updated title",
        content: "updated content",
        category: "services",
      });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.note.id).toBe("n1");
      expect(mockInfraNote.update).toHaveBeenCalledWith({
        where: { id: "n1", machineId: "m1" },
        data: expect.objectContaining({ title: "updated title" }),
      });
    });

    it("throws when note doesn't belong to machine", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({
        id: "m1",
        name: "prod-web",
      });
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.notesUpsert.execute, {
          machineId: "m1",
          id: "other-note",
          title: "update",
          content: "content",
        }),
      ).rejects.toThrow("Note other-note not found for this machine");
    });

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.notesUpsert.execute, {
          machineId: "nonexistent",
          title: "new note",
          content: "content",
        }),
      ).rejects.toThrow("Machine nonexistent not found");
    });
  });

  describe("infra_notes_delete", () => {
    it("deletes note after ownership check", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue({
        id: "n1",
        title: "old note",
        machine: { userId: "user-123", name: "prod-web" },
      });
      vi.mocked(mockInfraNote.delete).mockResolvedValue({});

      const result = await callExecute(ctx.notesDelete.execute, { id: "n1" });
      const text = parseResult((result.content[0] as { type: string; text: string }).text);

      expect(text.deleted).toBe(true);
      expect(text.machine).toBe("prod-web");
      expect(mockInfraNote.delete).toHaveBeenCalledWith({ where: { id: "n1" } });
    });

    it("throws when note not found", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.notesDelete.execute, { id: "nonexistent" })).rejects.toThrow(
        "Note nonexistent not found",
      );
    });

    it("throws when note belongs to another user", async () => {
      vi.mocked(mockInfraNote.findFirst).mockResolvedValue({
        id: "n1",
        machine: { userId: "other-user", name: "other-machine" },
      });

      await expect(callExecute(ctx.notesDelete.execute, { id: "n1" })).rejects.toThrow(
        "Note n1 not found",
      );
    });
  });
});
