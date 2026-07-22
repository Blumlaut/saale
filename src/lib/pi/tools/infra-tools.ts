import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import {
  executeCommand,
  readFile as sftpReadFile,
  writeFile as sftpWriteFile,
  generateSshKeyPair,
} from "@/lib/infra/client";

/**
 * Create infrastructure tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's machines.
 */
export function createInfraTools(userId: string): ToolDefinition[] {
  return [
    // ─── infra_list_machines ─────────────────────────────────────────────

    defineTool({
      name: "infra_list_machines",
      label: "List Machines",
      description:
        "List all registered remote machines with their connection details (host, port, username, auth method).",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params) => {
        const machines = await prisma.infraMachine.findMany({
          where: { userId },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            host: true,
            port: true,
            username: true,
            authMethod: true,
            createdAt: true,
            notes: { select: { id: true, title: true, category: true } },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: machines.length,
                  machines: machines.map((m) => ({
                    id: m.id,
                    name: m.name,
                    host: m.host,
                    port: m.port,
                    username: m.username,
                    authMethod: m.authMethod,
                    noteCount: m.notes.length,
                    createdAt: m.createdAt.toISOString(),
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: machines.length },
        };
      },
    }),

    // ─── infra_add_machine ───────────────────────────────────────────────

    defineTool({
      name: "infra_add_machine",
      label: "Add Machine",
      description:
        "Register a new remote machine for SSH access. Supports key-based auth (Saale generates an ED25519 key pair automatically) or password auth. For key auth, the returned 'authorizedKeysEntry' must be added to the remote user's ~/.ssh/authorized_keys file before the machine can be used. Use 'infra_test_connection' after adding to verify credentials work.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "User-friendly label (e.g. 'prod-web-01', 'home-server'). Must be unique per user.",
        }),
        host: Type.String({
          description: "Hostname or IP address.",
        }),
        port: Type.Optional(
          Type.Integer({
            description: "SSH port. Default: 22.",
            default: 22,
          }),
        ),
        username: Type.String({
          description: "SSH username.",
        }),
        authMethod: Type.Union([Type.Literal("key"), Type.Literal("password")], {
          description:
            "Authentication method. 'key' generates an ED25519 key pair (Saale stores the private key, you add the public key to the server). 'password' uses password auth.",
        }),
        password: Type.Optional(
          Type.String({
            description: "SSH password. Required when authMethod='password'.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        if (params.authMethod === "password" && !params.password) {
          throw new Error("password is required when authMethod='password'");
        }

        let authorizedKeysEntry: string | undefined;

        const machine = await prisma.infraMachine.create({
          data: {
            userId,
            name: params.name,
            host: params.host,
            port: params.port ?? 22,
            username: params.username,
            authMethod: params.authMethod,
            ...(params.authMethod === "key"
              ? (() => {
                  const { privateKey, publicKey } = generateSshKeyPair();
                  authorizedKeysEntry = publicKey;
                  return { encryptedKey: encrypt(privateKey) };
                })()
              : {}),
            ...(params.authMethod === "password" && params.password
              ? { encryptedPass: encrypt(params.password) }
              : {}),
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  added: true,
                  machine: {
                    id: machine.id,
                    name: machine.name,
                    host: machine.host,
                    port: machine.port,
                    username: machine.username,
                    authMethod: machine.authMethod,
                  },
                  ...(params.authMethod === "key"
                    ? {
                        authorizedKeysEntry,
                        setupInstructions: [
                          `Add this line to ${params.username}@${params.host}:${params.port ?? 22}'s ~/.ssh/authorized_keys:`,
                          `  ${authorizedKeysEntry}`,
                          `Then run 'infra_test_connection' to verify the connection works.`,
                        ].join("\n"),
                      }
                    : {
                        note: "Use 'infra_test_connection' to verify credentials, then 'infra_exec' to run commands.",
                      }),
                },
                null,
                2,
              ),
            },
          ],
          details: { id: machine.id },
        };
      },
    }),

    // ─── infra_remove_machine ────────────────────────────────────────────

    defineTool({
      name: "infra_remove_machine",
      label: "Remove Machine",
      description: "Remove a registered machine and all its notes. This cannot be undone.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        await prisma.infraMachine.delete({
          where: { id: params.id, userId },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  removed: true,
                  id: params.id,
                  name: machine.name,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: params.id },
        };
      },
    }),

    // ─── infra_exec ──────────────────────────────────────────────────────

    defineTool({
      name: "infra_exec",
      label: "Execute Command",
      description:
        "Run a shell command on a remote machine via SSH. Connects, executes, collects output, and disconnects. Default timeout is 30 seconds — increase for longer commands. Output is truncated at 50KB.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        command: Type.String({
          description: "Shell command to execute.",
        }),
        timeout: Type.Optional(
          Type.Integer({
            description:
              "Hard timeout in seconds. Default: 30. Use higher values for commands like package installs or database migrations.",
            default: 30,
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            description: "Working directory on the remote machine.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Verify ownership
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        if (!params.command || !params.command.trim()) {
          throw new Error("command must not be empty");
        }

        const execOptions: { timeout: number; cwd?: string } = {
          timeout: params.timeout ?? 30,
        };
        if (params.cwd) execOptions.cwd = params.cwd;

        const result = await executeCommand(params.id, userId, params.command, execOptions);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: machine.name,
                  command: params.command,
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  truncated: result.truncated,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2,
              ),
            },
          ],
          details: { exitCode: result.exitCode, timedOut: result.timedOut },
        };
      },
    }),

    // ─── infra_read_file ─────────────────────────────────────────────────

    defineTool({
      name: "infra_read_file",
      label: "Read Remote File",
      description: "Read a file from a remote machine via SFTP. Output is truncated at 50KB.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        path: Type.String({
          description: "Absolute path to the file on the remote machine.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        const result = await sftpReadFile(params.id, userId, params.path);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: machine.name,
                  path: params.path,
                  truncated: result.truncated,
                  content: result.content,
                },
                null,
                2,
              ),
            },
          ],
          details: { truncated: result.truncated },
        };
      },
    }),

    // ─── infra_write_file ────────────────────────────────────────────────

    defineTool({
      name: "infra_write_file",
      label: "Write Remote File",
      description:
        "Write content to a file on a remote machine via SFTP. Creates parent directories if needed.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        path: Type.String({
          description: "Absolute path for the file on the remote machine.",
        }),
        content: Type.String({
          description: "File content to write.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        const result = await sftpWriteFile(params.id, userId, params.path, params.content);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: machine.name,
                  path: params.path,
                  ok: result.ok,
                },
                null,
                2,
              ),
            },
          ],
          details: { ok: result.ok },
        };
      },
    }),

    // ─── infra_notes_list ────────────────────────────────────────────────

    defineTool({
      name: "infra_notes_list",
      label: "List Machine Notes",
      description:
        "List all notes for a machine. Notes contain agent-maintained knowledge about the system: services, paths, configurations, quirks, credentials.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        category: Type.Optional(
          Type.String({
            description:
              "Filter by category: 'general', 'services', 'paths', 'credentials', 'quirks', 'config'.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        const where: Record<string, unknown> = { machineId: params.id };
        if (params.category) {
          where.category = params.category;
        }

        const notes = await prisma.infraNote.findMany({
          where,
          orderBy: { updatedAt: "desc" },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: machine.name,
                  count: notes.length,
                  notes: notes.map((n) => ({
                    id: n.id,
                    title: n.title,
                    category: n.category,
                    updatedAt: n.updatedAt.toISOString(),
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: notes.length },
        };
      },
    }),

    // ─── infra_notes_get ─────────────────────────────────────────────────

    defineTool({
      name: "infra_notes_get",
      label: "Get Machine Note",
      description: "Get the full content of a specific note.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const note = await prisma.infraNote.findFirst({
          where: { id: params.id },
          include: { machine: { select: { userId: true, name: true } } },
        });

        if (!note) {
          throw new Error(`Note ${params.id} not found`);
        }

        if (note.machine.userId !== userId) {
          throw new Error(`Note ${params.id} not found`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: note.machine.name,
                  note: {
                    id: note.id,
                    title: note.title,
                    category: note.category,
                    content: note.content,
                    updatedAt: note.updatedAt.toISOString(),
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { id: note.id },
        };
      },
    }),

    // ─── infra_notes_upsert ──────────────────────────────────────────────

    defineTool({
      name: "infra_notes_upsert",
      label: "Upsert Machine Note",
      description:
        "Create or update a note for a machine. Use this to record knowledge about the system: what services run, important paths, configuration details, known quirks, credentials, etc. If a note ID is provided, it updates that note. Otherwise it creates a new one.",
      parameters: Type.Object({
        machineId: Type.String({ description: "Machine ID." }),
        title: Type.String({ description: "Note title." }),
        content: Type.String({ description: "Note content." }),
        category: Type.Optional(
          Type.Union(
            [
              Type.Literal("general"),
              Type.Literal("services"),
              Type.Literal("paths"),
              Type.Literal("credentials"),
              Type.Literal("quirks"),
              Type.Literal("config"),
            ],
            { description: "Note category. Default: 'general'.", default: "general" },
          ),
        ),
        id: Type.Optional(
          Type.String({
            description: "Existing note ID to update. Omit to create a new note.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Verify machine ownership
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.machineId, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.machineId} not found`);
        }

        const data = {
          title: params.title,
          content: params.content,
          category: params.category ?? "general",
        };

        let note;
        if (params.id) {
          // Update existing — verify it belongs to this machine
          const existing = await prisma.infraNote.findFirst({
            where: { id: params.id, machineId: params.machineId },
          });

          if (!existing) {
            throw new Error(`Note ${params.id} not found for this machine`);
          }

          note = await prisma.infraNote.update({
            where: { id: params.id },
            data,
          });
        } else {
          note = await prisma.infraNote.create({
            data: { ...data, machineId: params.machineId },
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  machine: machine.name,
                  note: {
                    id: note.id,
                    title: note.title,
                    category: note.category,
                    updatedAt: note.updatedAt.toISOString(),
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { id: note.id },
        };
      },
    }),

    // ─── infra_notes_delete ──────────────────────────────────────────────

    defineTool({
      name: "infra_notes_delete",
      label: "Delete Machine Note",
      description: "Delete a note for a machine.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const note = await prisma.infraNote.findFirst({
          where: { id: params.id },
          include: { machine: { select: { userId: true, name: true } } },
        });

        if (!note) {
          throw new Error(`Note ${params.id} not found`);
        }

        if (note.machine.userId !== userId) {
          throw new Error(`Note ${params.id} not found`);
        }

        await prisma.infraNote.delete({ where: { id: params.id } });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deleted: true,
                  machine: note.machine.name,
                  id: params.id,
                  title: note.title,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: params.id },
        };
      },
    }),
  ];
}
