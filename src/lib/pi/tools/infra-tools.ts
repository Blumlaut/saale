import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { executeCommand, writeFile as sftpWriteFile, generateSshKeyPair } from "@/lib/infra/client";

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
        "List all registered remote machines with their connection details (host, port, username, auth method) and how many notes each has.",
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

        // Structured metadata for UI rendering (machine list cards)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_list_machines" as const,
            count: machines.length,
            machines: machines.map((m) => ({
              id: m.id,
              name: m.name,
              host: m.host,
              port: m.port,
              username: m.username,
              authMethod: m.authMethod,
              noteCount: m.notes.length,
            })),
          },
        };

        const machineEntries = machines.map((m) => ({
          id: m.id,
          name: m.name,
          host: m.host,
          port: m.port,
          username: m.username,
          authMethod: m.authMethod,
          noteCount: m.notes.length,
          createdAt: m.createdAt.toISOString(),
        }));

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify({ count: machines.length, machines: machineEntries }, null, 2) +
                `\n${JSON.stringify(infraMeta)}`,
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

        // Structured metadata for UI rendering (add machine card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_add_machine" as const,
            machineId: machine.id,
            machineName: machine.name,
            host: machine.host,
            port: machine.port,
            username: machine.username,
            authMethod: machine.authMethod,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
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
                ) + `\n${JSON.stringify(infraMeta)}`,
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

        // Structured metadata for UI rendering (remove machine card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_remove_machine" as const,
            machineId: params.id,
            machineName: machine.name,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
                  {
                    removed: true,
                    id: params.id,
                    name: machine.name,
                  },
                  null,
                  2,
                ) + `\n${JSON.stringify(infraMeta)}`,
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

        // Structured metadata for UI rendering (exec result cards)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_exec" as const,
            machineId: params.id,
            machineName: machine.name,
            command: params.command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: result.stdout.split("\n")[0] ?? "",
            stderr: result.stderr.split("\n")[0] ?? "",
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
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
                ) + `\n${JSON.stringify(infraMeta)}`,
            },
          ],
          details: { exitCode: result.exitCode, timedOut: result.timedOut },
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

        // Structured metadata for UI rendering (write file card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_write_file" as const,
            machineId: params.id,
            machineName: machine.name,
            path: params.path,
            ok: result.ok,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
                  {
                    machine: machine.name,
                    path: params.path,
                    ok: result.ok,
                  },
                  null,
                  2,
                ) + `\n${JSON.stringify(infraMeta)}`,
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
        "List the notes for a machine. Notes are the durable record of what that machine is right now: services, paths, configuration, quirks, credentials. Read them before inspecting or changing a machine, and before writing a note so you can update the existing one instead of creating a duplicate.",
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

        // Structured metadata for UI rendering (notes list cards)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_notes_list" as const,
            machineId: params.id,
            machineName: machine.name,
            count: notes.length,
            notes: notes.map((n) => ({
              id: n.id,
              title: n.title,
              category: n.category,
              updatedAt: n.updatedAt.toISOString(),
            })),
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
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
                ) + `\n${JSON.stringify(infraMeta)}`,
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
      description: "Read one note in full. Use `infra_notes_list` first to find the note ID.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const note = await prisma.infraNote.findFirst({
          where: { id: params.id },
          include: { machine: { select: { id: true, userId: true, name: true } } },
        });

        if (!note) {
          throw new Error(`Note ${params.id} not found`);
        }

        if (note.machine.userId !== userId) {
          throw new Error(`Note ${params.id} not found`);
        }

        // Structured metadata for UI rendering (note get card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_notes_get" as const,
            machineId: note.machine.id,
            machineName: note.machine.name,
            noteId: note.id,
            noteTitle: note.title,
            noteCategory: note.category,
            contentPreview: note.content.slice(0, 200),
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
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
                ) + `\n${JSON.stringify(infraMeta)}`,
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
        "Create or update a machine note. Notes record only what the machine is right now: verified present-state facts — never plans, intentions, TODOs, command output, or values that change on their own (ephemeral addresses, process IDs, versions mid-upgrade). To avoid duplicates, call `infra_notes_list` first and pass the existing note's `id` when one already covers the topic; omit `id` only when creating a note for a topic that has none. When reality changes, update the note; when a note is no longer true and nothing replaces it, delete it.",
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
            where: { id: params.id, machineId: params.machineId },
            data,
          });
        } else {
          note = await prisma.infraNote.create({
            data: { ...data, machineId: params.machineId },
          });
        }

        // Structured metadata for UI rendering (note upsert card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_notes_upsert" as const,
            machineId: params.machineId,
            machineName: machine.name,
            noteId: note.id,
            noteTitle: note.title,
            noteCategory: note.category,
            isUpdate: !!params.id,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
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
                ) + `\n${JSON.stringify(infraMeta)}`,
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
      description:
        "Delete a note that is no longer true or has been superseded. Removing stale notes is part of keeping a machine's notes accurate.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const note = await prisma.infraNote.findFirst({
          where: { id: params.id },
          include: { machine: { select: { id: true, userId: true, name: true } } },
        });

        if (!note) {
          throw new Error(`Note ${params.id} not found`);
        }

        if (note.machine.userId !== userId) {
          throw new Error(`Note ${params.id} not found`);
        }

        // Structured metadata for UI rendering (note delete card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_notes_delete" as const,
            machineId: note.machine.id,
            machineName: note.machine.name,
            noteId: params.id,
            noteTitle: note.title,
          },
        };

        await prisma.infraNote.delete({ where: { id: params.id } });

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
                  {
                    deleted: true,
                    machine: note.machine.name,
                    id: params.id,
                    title: note.title,
                  },
                  null,
                  2,
                ) + `\n${JSON.stringify(infraMeta)}`,
            },
          ],
          details: { id: params.id },
        };
      },
    }),
  ];
}
