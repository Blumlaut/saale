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
  writeFile: vi.fn(),
  generateSshKeyPair: vi.fn(() => ({
    privateKey:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nmock-private-key\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyData",
  })),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import * as client from "@/lib/infra/client";

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
    ctx.writeFile = tools.find((t: { name: string }) => t.name === "infra_write_file")!;
    ctx.notesList = tools.find((t: { name: string }) => t.name === "infra_notes_list")!;
    ctx.notesGet = tools.find((t: { name: string }) => t.name === "infra_notes_get")!;
    ctx.notesUpsert = tools.find((t: { name: string }) => t.name === "infra_notes_upsert")!;
    ctx.notesDelete = tools.find((t: { name: string }) => t.name === "infra_notes_delete")!;
  });

  it("returns all 9 expected tools", () => {
    const names = ctx.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("infra_list_machines");
    expect(names).toContain("infra_add_machine");
    expect(names).toContain("infra_remove_machine");
    expect(names).toContain("infra_exec");
    expect(names).toContain("infra_write_file");
    expect(names).toContain("infra_notes_list");
    expect(names).toContain("infra_notes_get");
    expect(names).toContain("infra_notes_upsert");
    expect(names).toContain("infra_notes_delete");
    expect(names).toHaveLength(9);
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

  describe("infra_write_file", () => {
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

    it("throws when machine not found", async () => {
      vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.writeFile.execute, {
          id: "nonexistent",
          path: "/tmp/test.txt",
          content: "hello",
        }),
      ).rejects.toThrow("Machine nonexistent not found");
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
