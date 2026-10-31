import {
  createEditToolDefinition,
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type EditOperations,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
// Remote paths are POSIX whatever the host platform is, so never resolve them
// with the platform-sensitive `path` helpers.
import { posix } from "path";
import { Type, type Static } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { detectImageMimeTypeFromBuffer, IMAGE_SNIFF_BYTES } from "@/lib/image-sniff";
import {
  createDirectory,
  executeCommand,
  formatBytes,
  MAX_TRANSFER_BYTES,
  readFileForTransfer,
  readFileHead,
  readFileRaw,
  statFile,
  writeFile as sftpWriteFile,
  writeFileBuffer,
  generateSshKeyPair,
} from "@/lib/infra/client";
import { createLocalFileProvider } from "@/lib/files/local-provider";
import type { FileProvider } from "@/lib/files/provider";
import { requireWithinRoot } from "@/lib/files/paths";
import { userWorkspacePath, workspaceOwner } from "@/lib/sandbox/workspace";

/**
 * Base the SDK's file tools resolve paths against when they are handed no tool
 * context. Remote paths are rejected unless absolute, so this is only ever a
 * fallback. a host session cwd must never leak into a remote path.
 */
const REMOTE_ROOT = "/";

/** Max characters of an edit diff embedded in the tool result. */
const MAX_DIFF_CHARS = 4000;

/** Max characters of a file preview embedded in the read result. */
const MAX_FILE_PREVIEW_CHARS = 200;

/**
 * Bound a diff so one large edit cannot flood the transcript. The model made
 * the edits. the diff is for the user, and the first screen is what matters.
 */
function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\u2026 [diff truncated at ${MAX_DIFF_CHARS} characters]`;
}

/**
 * The workspace a download lands in: the only filesystem on this side that the
 * agent's file tools can read and edit.
 */
function requireWorkspace(userId: string): string {
  return userWorkspacePath(userId);
}

/** The workspace as a provider, so a transfer goes through the same path guard as a browse. */
function workspaceFiles(userId: string): FileProvider {
  return createLocalFileProvider({ root: requireWorkspace(userId), owner: workspaceOwner() });
}

/**
 * Resolve a workspace path to the absolute path the agent's file tools use.
 * A relative path resolves against the workspace root; anything that escapes
 * that root is refused. a transfer must never touch another part of the
 * container.
 */
function resolveWorkspacePath(homeDir: string, path: string): string {
  const resolved = posix.normalize(path.startsWith("/") ? path : posix.join(homeDir, path));
  if (resolved !== homeDir && !resolved.startsWith(`${homeDir}/`)) {
    throw new Error(`"${path}" is outside the workspace (${homeDir})`);
  }
  return resolved;
}

/**
 * Size of a workspace file, refusing a directory. Enough to reject an oversize
 * file before its bytes are read.
 */
async function statWorkspaceFile(userId: string, absolutePath: string): Promise<{ size: number }> {
  const stat = await workspaceFiles(userId).stat(absolutePath);
  if (!stat) throw new Error(`${absolutePath} does not exist in the workspace`);
  if (stat.kind !== "file") throw new Error(`${absolutePath} is a directory, not a file`);
  return { size: stat.size };
}

/**
 * Create infrastructure tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's machines.
 */
/** A registered machine, as the list reports it. */
const MACHINE_SCHEMA = Type.Object({
  id: Type.String(),
  name: Type.String(),
  host: Type.String(),
  port: Type.Integer(),
  username: Type.String(),
  authMethod: Type.String(),
  noteCount: Type.Integer(),
  createdAt: Type.String(),
});

/** The machine a tool acted on, without its notes. */
const MACHINE_SUMMARY_SCHEMA = Type.Object({
  id: Type.String(),
  name: Type.String(),
  host: Type.String(),
  port: Type.Integer(),
  username: Type.String(),
  authMethod: Type.String(),
});

const MACHINES_SCHEMA = Type.Object({
  count: Type.Integer(),
  machines: Type.Array(MACHINE_SCHEMA),
});

const MACHINE_ADDED_SCHEMA = Type.Object({
  added: Type.Boolean(),
  machine: MACHINE_SUMMARY_SCHEMA,
  /** The public key to install, for key auth. */
  authorizedKeysEntry: Type.Optional(Type.String()),
  setupInstructions: Type.Optional(Type.String()),
  /** Guidance for password auth, where there is no key to install. */
  note: Type.Optional(Type.String()),
});

const MACHINE_REMOVED_SCHEMA = Type.Object({
  removed: Type.Boolean(),
  id: Type.String(),
  name: Type.String(),
});

/** What a command on a machine returned. */
const EXEC_SCHEMA = Type.Object({
  machine: Type.String(),
  command: Type.String(),
  /** Null when the command was killed by a signal rather than exiting. */
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  timedOut: Type.Boolean(),
  truncated: Type.Boolean(),
  stdout: Type.String(),
  stderr: Type.String(),
});

const READ_FILE_SCHEMA = Type.Object({
  machine: Type.String(),
  path: Type.String(),
  truncated: Type.Boolean(),
  totalLines: Type.Optional(Type.Integer()),
  /** The file's text, when it was read as text. */
  content: Type.Optional(Type.String()),
  /** Set when the file was read as an image instead. */
  imageMimeType: Type.Optional(Type.String()),
});

const WRITE_FILE_SCHEMA = Type.Object({
  machine: Type.String(),
  path: Type.String(),
  ok: Type.Boolean(),
});

const EDIT_FILE_SCHEMA = Type.Object({
  machine: Type.String(),
  path: Type.String(),
  replacements: Type.Integer(),
  diff: Type.String(),
});

const DOWNLOAD_FILE_SCHEMA = Type.Object({
  machine: Type.String(),
  remotePath: Type.String(),
  localPath: Type.String(),
  size: Type.Integer(),
  downloaded: Type.Boolean(),
});

const UPLOAD_FILE_SCHEMA = Type.Object({
  machine: Type.String(),
  localPath: Type.String(),
  remotePath: Type.String(),
  size: Type.Integer(),
  uploaded: Type.Boolean(),
});

/** One note, without its body. what the list shows. */
const NOTE_SUMMARY_SCHEMA = Type.Object({
  id: Type.String(),
  title: Type.String(),
  category: Type.String(),
  updatedAt: Type.String(),
});

const NOTES_LIST_SCHEMA = Type.Object({
  machine: Type.String(),
  count: Type.Integer(),
  notes: Type.Array(NOTE_SUMMARY_SCHEMA),
});

const NOTE_GET_SCHEMA = Type.Object({
  machine: Type.String(),
  note: Type.Object({
    id: Type.String(),
    title: Type.String(),
    category: Type.String(),
    content: Type.String(),
    updatedAt: Type.String(),
  }),
});

const NOTE_UPSERT_SCHEMA = Type.Object({
  machine: Type.String(),
  note: NOTE_SUMMARY_SCHEMA,
});

const NOTE_DELETED_SCHEMA = Type.Object({
  deleted: Type.Boolean(),
  machine: Type.String(),
  id: Type.String(),
  title: Type.String(),
});

export function createInfraTools(userId: string): ToolDefinition[] {
  // ─── Remote file operations (SFTP) ────────────────────────────────────
  //
  // `infra_read_file` and `infra_edit_file` are Pi's own read and edit tools
  // with SFTP operations: the SDK exposes `ReadOperations`/`EditOperations`
  // for exactly this ("delegate file reading/editing to remote systems (for
  // example SSH)"), so line/byte truncation, offset paging, image handling,
  // exact and fuzzy text matching, uniqueness checks, BOM and line-ending
  // preservation and diff generation all stay in the SDK.
  //
  // Pi hands the operations an absolute path and nothing else, so the target
  // machine travels through this closure. Both tools are declared
  // `executionMode: "sequential"`, which stops their calls from overlapping,
  // and the closure is per-session, so separate sessions cannot collide.
  let activeMachineId: string | null = null;

  const activeMachineOrThrow = (): string => {
    if (!activeMachineId) {
      throw new Error("No remote machine selected");
    }
    return activeMachineId;
  };

  /** SFTP `access`: the file must exist and be a regular file. */
  const accessRemoteFile = async (absolutePath: string): Promise<void> => {
    const stats = await statFile(activeMachineOrThrow(), userId, absolutePath).catch((err) => {
      // The SDK renders a bare SFTP status code for a missing path, which
      // tells the model nothing useful.
      console.error(`Failed to stat ${absolutePath} on the remote machine:`, err);
      throw new Error(`${absolutePath} does not exist or cannot be read`);
    });

    if (stats.type !== "file") {
      throw new Error(`${absolutePath} is a directory, not a file`);
    }
  };

  const readRemoteFile = (absolutePath: string): Promise<Buffer> =>
    readFileRaw(activeMachineOrThrow(), userId, absolutePath);

  const readOperations: ReadOperations = {
    readFile: readRemoteFile,
    access: accessRemoteFile,
    detectImageMimeType: async (absolutePath) => {
      const head = await readFileHead(
        activeMachineOrThrow(),
        userId,
        absolutePath,
        IMAGE_SNIFF_BYTES,
      );
      return detectImageMimeTypeFromBuffer(head);
    },
  };

  const editOperations: EditOperations = {
    readFile: readRemoteFile,
    writeFile: async (absolutePath, content) => {
      await sftpWriteFile(activeMachineOrThrow(), userId, absolutePath, content);
    },
    access: accessRemoteFile,
  };

  const remoteReadTool = createReadToolDefinition(REMOTE_ROOT, { operations: readOperations });
  const remoteEditTool = createEditToolDefinition(REMOTE_ROOT, { operations: editOperations });

  const readParameters = Type.Object({
    id: Type.String({ description: "Machine ID." }),
    // Pi's own `path`/`offset`/`limit` schemas, so their guidance stays in one place.
    path: remoteReadTool.parameters.properties.path,
    offset: remoteReadTool.parameters.properties.offset,
    limit: remoteReadTool.parameters.properties.limit,
  });

  const editParameters = Type.Object({
    id: Type.String({ description: "Machine ID." }),
    path: remoteEditTool.parameters.properties.path,
    edits: remoteEditTool.parameters.properties.edits,
  });

  // Pi's argument shim repairs `edits` sent as a JSON string or as a single
  // object, and otherwise returns the arguments untouched. so the extra `id`
  // field survives it even though its declared return type does not mention it.
  const prepareEditArguments = remoteEditTool.prepareArguments as
    ((args: unknown) => Static<typeof editParameters>) | undefined;

  return [
    // ─── infra_list_machines ─────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_list_machines",
      label: "List Machines",
      description:
        "List all registered remote machines with their connection details (host, port, username, auth method) and how many notes each has.",
      parameters: Type.Object({}),
      outputSchema: MACHINES_SCHEMA,
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
          value: { count: machines.length, machines: machineEntries },
          meta: infraMeta,
          details: { count: machines.length },
        };
      },
    }),

    // ─── infra_add_machine ───────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_add_machine",
      label: "Add Machine",
      description:
        "Register a new remote machine for SSH access. Supports key-based auth (Saale generates an ED25519 key pair automatically) or password auth. For key auth, the returned 'authorizedKeysEntry' must be added to the remote user's ~/.ssh/authorized_keys file before the machine can be used.",
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
      outputSchema: MACHINE_ADDED_SCHEMA,
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
          value: {
            added: true,
            machine: {
              id: machine.id,
              name: machine.name,
              host: machine.host,
              port: machine.port,
              username: machine.username,
              authMethod: machine.authMethod,
            },
            // Key auth always produced an entry above; the check keeps an
            // undefined key out of the result a script reads.
            ...(params.authMethod === "key" && authorizedKeysEntry
              ? {
                  authorizedKeysEntry,
                  setupInstructions: [
                    `Add this line to ${params.username}@${params.host}:${params.port ?? 22}'s ~/.ssh/authorized_keys:`,
                    `  ${authorizedKeysEntry}`,
                  ].join("\n"),
                }
              : {
                  note: "Use 'infra_exec' to run commands on it.",
                }),
          },
          meta: infraMeta,
          details: { id: machine.id },
        };
      },
    }),

    // ─── infra_remove_machine ────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_remove_machine",
      label: "Remove Machine",
      description: "Remove a registered machine and all its notes. This cannot be undone.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
      }),
      outputSchema: MACHINE_REMOVED_SCHEMA,
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
          value: {
            removed: true,
            id: params.id,
            name: machine.name,
          },
          meta: infraMeta,
          details: { id: params.id },
        };
      },
    }),

    // ─── infra_exec ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_exec",
      label: "Execute Command",
      description:
        "Run a shell command on a remote machine via SSH. Connects, executes, collects output, and disconnects. The command runs in the machine's own login shell: a POSIX shell on Unix, cmd.exe on Windows. Default timeout is 30 seconds. increase for longer commands. Output is truncated at 50KB.",
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
      outputSchema: EXEC_SCHEMA,
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
            // The reason a null exit code has one: the remote killed it.
            signal: result.signal,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: result.stdout.split("\n")[0] ?? "",
            stderr: result.stderr.split("\n")[0] ?? "",
          },
        };

        return {
          value: {
            machine: machine.name,
            command: params.command,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          meta: infraMeta,
          details: { exitCode: result.exitCode, timedOut: result.timedOut },
        };
      },
    }),

    // ─── infra_read_file ─────────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_read_file",
      label: "Read Remote File",
      description: `Read a file from a remote machine over SFTP. Supports text files and images (jpg, png, gif, webp). images are sent as attachments. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); use offset/limit for larger files. Read a file before \`infra_edit_file\`: edits are matched against the file's exact current content.`,
      ...(remoteReadTool.promptSnippet ? { promptSnippet: remoteReadTool.promptSnippet } : {}),
      ...(remoteReadTool.promptGuidelines
        ? { promptGuidelines: remoteReadTool.promptGuidelines }
        : {}),
      parameters: readParameters,
      ...(remoteReadTool.constrainedSampling
        ? { constrainedSampling: remoteReadTool.constrainedSampling }
        : {}),
      executionMode: "sequential",
      outputSchema: READ_FILE_SCHEMA,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        // The SDK resolves a relative path against the session's cwd, which is
        // a host path. that would silently read a path that is meaningless on
        // the remote machine. Remote paths are absolute by contract.
        if (!params.path.startsWith("/")) {
          throw new Error(
            `path must be absolute (got "${params.path}"). A remote path is resolved on the machine, not in Saale's workspace.`,
          );
        }

        activeMachineId = params.id;

        const read = await remoteReadTool.execute(
          toolCallId,
          {
            path: params.path,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          },
          signal,
          onUpdate,
          ctx,
        );

        const content = read.content ?? [];
        const image = content.find((block) => block.type === "image");
        const text = content.find((block) => block.type === "text");
        const truncation = read.details?.truncation;

        // Structured metadata for UI rendering (read file card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_read_file" as const,
            machineId: params.id,
            machineName: machine.name,
            path: params.path,
            truncated: truncation?.truncated ?? false,
            totalLines: truncation?.totalLines,
            preview: (text?.type === "text" ? text.text : "").slice(0, MAX_FILE_PREVIEW_CHARS),
            imageMimeType: image?.type === "image" ? image.mimeType : undefined,
          },
        };

        return {
          // Pi's blocks are kept intact. an image read is an attachment, not
          // something to stringify. The metadata rides along as one more block.
          value: {
            machine: machine.name,
            path: params.path,
            truncated: truncation?.truncated ?? false,
            ...(truncation ? { totalLines: truncation.totalLines } : {}),
            ...(text?.type === "text" ? { content: text.text } : {}),
            ...(image?.type === "image" ? { imageMimeType: image.mimeType } : {}),
          },
          text: text?.type === "text" ? text.text : "",
          ...(image ? { content: [image] } : {}),
          meta: infraMeta,
          details: read.details,
        };
      },
    }),

    // ─── infra_write_file ────────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_write_file",
      label: "Write Remote File",
      description:
        "Write content to a file on a remote machine, replacing the file's entire contents. Creates parent directories if needed. For a change to part of an existing file, use `infra_edit_file` instead. sending the whole file back is expensive and risks dropping everything you did not mean to touch.",
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        path: Type.String({
          description: "Absolute path for the file on the remote machine.",
        }),
        content: Type.String({
          description: "File content to write.",
        }),
      }),
      outputSchema: WRITE_FILE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        // SFTP's write does not create parent directories (Pi's own write tool
        // does, and this tool promises the same).
        const parentDir = posix.dirname(params.path);
        if (parentDir !== "." && parentDir !== "/") {
          await createDirectory(params.id, userId, parentDir);
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
          value: {
            machine: machine.name,
            path: params.path,
            ok: result.ok,
          },
          meta: infraMeta,
          details: { ok: result.ok },
        };
      },
    }),

    // ─── infra_edit_file ────────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_edit_file",
      label: "Edit Remote File",
      description:
        "Edit a file on a remote machine with exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the file's current content. read it with `infra_read_file` first. When changing several places in one file, send one call with multiple entries in edits[] instead of several calls. Prefer this over `infra_write_file` for any change to an existing file.",
      // The prompt guidance Pi ships with its edit tool, minus its TUI
      // renderers. a headless host never draws them.
      ...(remoteEditTool.promptSnippet ? { promptSnippet: remoteEditTool.promptSnippet } : {}),
      ...(remoteEditTool.promptGuidelines
        ? { promptGuidelines: remoteEditTool.promptGuidelines }
        : {}),
      parameters: editParameters,
      ...(prepareEditArguments ? { prepareArguments: prepareEditArguments } : {}),
      ...(remoteEditTool.constrainedSampling
        ? { constrainedSampling: remoteEditTool.constrainedSampling }
        : {}),
      executionMode: "sequential",
      outputSchema: EDIT_FILE_SCHEMA,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        // The SDK resolves a relative path against the session's cwd, which is
        // a host path. that would silently target a path that is meaningless
        // on the remote machine. Remote paths are absolute by contract.
        if (!params.path.startsWith("/")) {
          throw new Error(
            `path must be absolute (got "${params.path}"). A remote path is resolved on the machine, not in Saale's workspace.`,
          );
        }

        activeMachineId = params.id;

        const edited = await remoteEditTool.execute(
          toolCallId,
          { path: params.path, edits: params.edits },
          signal,
          onUpdate,
          ctx,
        );

        const diff = truncateDiff(edited.details?.diff ?? "");

        // Structured metadata for UI rendering (edit file card)
        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_edit_file" as const,
            machineId: params.id,
            machineName: machine.name,
            path: params.path,
            replacements: params.edits.length,
            firstChangedLine: edited.details?.firstChangedLine,
            diff,
          },
        };

        return {
          value: {
            machine: machine.name,
            path: params.path,
            replacements: params.edits.length,
            diff,
          },
          meta: infraMeta,
          details: edited.details,
        };
      },
    }),

    // ─── infra_download_file ──────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_download_file",
      label: "Download Remote File",
      description: `Download a file from a remote machine into the agent workspace over SFTP, so it can be inspected and changed with the local file tools. Use this instead of \`infra_read_file\` for binary files, files too large to read as text, or anything that will be edited and sent back with \`infra_upload_file\`. The destination defaults to the file's name at the workspace root, and an existing file there is overwritten. Files over ${formatBytes(MAX_TRANSFER_BYTES)} are refused.`,
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        path: Type.String({
          description: "Absolute path of the file on the remote machine.",
        }),
        dest: Type.Optional(
          Type.String({
            description:
              "Workspace path to write to, relative to the workspace root (or absolute inside it). Default: the remote file's name at the workspace root.",
          }),
        ),
      }),
      outputSchema: DOWNLOAD_FILE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        if (!params.path.startsWith("/")) {
          throw new Error(
            `path must be absolute (got "${params.path}"). A remote path is resolved on the machine, not in Saale's workspace.`,
          );
        }

        const homeDir = requireWorkspace(userId);
        const dest = resolveWorkspacePath(
          homeDir,
          params.dest?.trim() || posix.basename(params.path),
        );

        const { buffer, size } = await readFileForTransfer(params.id, userId, params.path);
        const files = workspaceFiles(userId);
        await files.write(requireWithinRoot(requireWorkspace(userId), dest), buffer);
        const written = { path: dest };

        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_download_file" as const,
            machineId: params.id,
            machineName: machine.name,
            path: params.path,
            localPath: written.path,
            size,
          },
        };

        return {
          value: {
            machine: machine.name,
            remotePath: params.path,
            localPath: written.path,
            size,
            downloaded: true,
          },
          meta: infraMeta,
          details: { localPath: written.path, size },
        };
      },
    }),

    // ─── infra_upload_file ───────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_upload_file",
      label: "Upload File",
      description: `Upload a file from the agent workspace to a remote machine over SFTP, replacing the destination file and creating parent directories as needed. Use this to send back a file changed locally after \`infra_download_file\`, or to deliver an artifact the model produced. Files over ${formatBytes(MAX_TRANSFER_BYTES)} are refused.`,
      parameters: Type.Object({
        id: Type.String({ description: "Machine ID." }),
        path: Type.String({
          description: "Absolute destination path for the file on the remote machine.",
        }),
        source: Type.String({
          description:
            "Workspace path of the file to upload, relative to the workspace root (or absolute inside it).",
        }),
      }),
      outputSchema: UPLOAD_FILE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const machine = await prisma.infraMachine.findFirst({
          where: { id: params.id, userId },
          select: { id: true, name: true },
        });

        if (!machine) {
          throw new Error(`Machine ${params.id} not found`);
        }

        if (!params.path.startsWith("/")) {
          throw new Error(
            `path must be absolute (got "${params.path}"). A remote path is resolved on the machine, not in Saale's workspace.`,
          );
        }

        const homeDir = requireWorkspace(userId);
        const source = resolveWorkspacePath(homeDir, params.source);

        const { size } = await statWorkspaceFile(userId, source);
        if (size > MAX_TRANSFER_BYTES) {
          throw new Error(
            `${source} is ${formatBytes(size)}, over the ${formatBytes(MAX_TRANSFER_BYTES)} transfer limit`,
          );
        }

        const file = await workspaceFiles(userId).read(
          requireWithinRoot(requireWorkspace(userId), source),
        );

        // SFTP's write does not create parent directories (Pi's own write tool
        // does, and this tool promises the same).
        const parentDir = posix.dirname(params.path);
        if (parentDir !== "." && parentDir !== "/") {
          await createDirectory(params.id, userId, parentDir);
        }

        const result = await writeFileBuffer(
          params.id,
          userId,
          params.path,
          Buffer.from(file.buffer),
        );

        const infraMeta = {
          _saaleInfraMeta: {
            type: "infra_upload_file" as const,
            machineId: params.id,
            machineName: machine.name,
            path: params.path,
            localPath: source,
            size: result.size,
          },
        };

        return {
          value: {
            machine: machine.name,
            localPath: source,
            remotePath: params.path,
            size: result.size,
            uploaded: result.ok,
          },
          meta: infraMeta,
          details: { remotePath: params.path, size: result.size },
        };
      },
    }),

    // ─── infra_notes_list ────────────────────────────────────────────────

    defineStructuredTool({
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
      outputSchema: NOTES_LIST_SCHEMA,
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
          value: {
            machine: machine.name,
            count: notes.length,
            notes: notes.map((n) => ({
              id: n.id,
              title: n.title,
              category: n.category,
              updatedAt: n.updatedAt.toISOString(),
            })),
          },
          meta: infraMeta,
          details: { count: notes.length },
        };
      },
    }),

    // ─── infra_notes_get ─────────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_notes_get",
      label: "Get Machine Note",
      description: "Read one note in full. Use `infra_notes_list` first to find the note ID.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      outputSchema: NOTE_GET_SCHEMA,
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
          value: {
            machine: note.machine.name,
            note: {
              id: note.id,
              title: note.title,
              category: note.category,
              content: note.content,
              updatedAt: note.updatedAt.toISOString(),
            },
          },
          meta: infraMeta,
          details: { id: note.id },
        };
      },
    }),

    // ─── infra_notes_upsert ──────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_notes_upsert",
      label: "Upsert Machine Note",
      description:
        "Create or update a machine note. Notes record only what the machine is right now: verified present-state facts. never plans, intentions, TODOs, command output, or values that change on their own (ephemeral addresses, process IDs, versions mid-upgrade). To avoid duplicates, call `infra_notes_list` first and pass the existing note's `id` when one already covers the topic; omit `id` only when creating a note for a topic that has none. When reality changes, update the note; when a note is no longer true and nothing replaces it, delete it.",
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
      outputSchema: NOTE_UPSERT_SCHEMA,
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
          // Update existing. verify it belongs to this machine
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
          value: {
            machine: machine.name,
            note: {
              id: note.id,
              title: note.title,
              category: note.category,
              updatedAt: note.updatedAt.toISOString(),
            },
          },
          meta: infraMeta,
          details: { id: note.id },
        };
      },
    }),

    // ─── infra_notes_delete ──────────────────────────────────────────────

    defineStructuredTool({
      name: "infra_notes_delete",
      label: "Delete Machine Note",
      description:
        "Delete a note that is no longer true or has been superseded. Removing stale notes is part of keeping a machine's notes accurate.",
      parameters: Type.Object({
        id: Type.String({ description: "Note ID." }),
      }),
      outputSchema: NOTE_DELETED_SCHEMA,
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
          value: {
            deleted: true,
            machine: note.machine.name,
            id: params.id,
            title: note.title,
          },
          meta: infraMeta,
          details: { id: params.id },
        };
      },
    }),
  ];
}
