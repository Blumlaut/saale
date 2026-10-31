/**
 * SSH client wrapper for infrastructure management.
 *
 * Per-command connect/disconnect. no persistent sessions.
 * Handles credential encryption/decryption, timeouts, and output limits.
 */

import { generateKeyPairSync } from "crypto";
import type { Client as SSH2Client, SFTPWrapper, Stats } from "ssh2";
import { NodeSSH } from "node-ssh";
import sshpk from "sshpk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  buildMkdirRequest,
  buildShellRequest,
  buildWriteRequest,
  parsePlatformProbe,
  InvalidExecOptionsError,
  PLATFORM_PROBE,
  type RemotePlatform,
  type ShellRequest,
} from "@/lib/infra/shell";

// ─── Limits ─────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30; // seconds
const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB
const CONNECT_TIMEOUT = 10000; // 10 seconds for SSH handshake

/**
 * Max bytes one workspace transfer (download or upload) may move.
 *
 * Both directions are buffered whole in the app's memory, so this is the
 * guard that keeps a single call from exhausting the server. Override with
 * `INFRA_TRANSFER_MAX_BYTES`.
 */
export const MAX_TRANSFER_BYTES = (() => {
  const raw = Number(process.env.INFRA_TRANSFER_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 50 * 1024 * 1024;
})();

/** Human-readable byte count for transfer errors and tool descriptions. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── Types ──────────────────────────────────────────────────────

export interface GeneratedKeyPair {
  /** PEM-encoded private key. */
  privateKey: string;
  /** SSH public key line for authorized_keys. */
  publicKey: string;
}

export interface ExecOptions {
  /** Hard timeout in seconds. Default: 30. */
  timeout?: number;
  /** Max output size in bytes. Default: 50KB. */
  maxOutput?: number;
  /** Working directory on the remote machine. */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Null when the command was killed by a signal rather than exiting. */
  exitCode: number | null;
  /** The signal that killed it, when one did. the reason `exitCode` is null. */
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface SftpListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: Date;
}

export interface SftpStatResult {
  type: "file" | "directory";
  size: number;
  modified: Date;
}

// ─── Key Generation ─────────────────────────────────────────────

/**
 * Generate an ED25519 SSH key pair.
 * Returns the private key in OpenSSH format (compatible with node-ssh/ssh2)
 * and the public key in authorized_keys format.
 */
export function generateSshKeyPair(): GeneratedKeyPair {
  // Node.js crypto only supports PKCS8 for ED25519, but ssh2 needs OpenSSH format.
  // sshpk handles the conversion cleanly.
  const { privateKey: pkcs8Pem } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const key = sshpk.parsePrivateKey(pkcs8Pem);

  return {
    privateKey: key.toString("ssh-private"),
    publicKey: key.toPublic().toString("ssh").split(" ").slice(0, 2).join(" "),
  };
}

// ─── Credential Resolution ──────────────────────────────────────

/**
 * Resolve SSH connection config from a stored machine record.
 * Decrypts credentials and returns a node-ssh config.
 * Requires userId for user isolation. always verify ownership before connecting.
 */
export async function resolveConnectionConfig(
  machineId: string,
  userId: string,
): Promise<{
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passPhrase?: string;
}> {
  const machine = await prisma.infraMachine.findFirst({
    where: { id: machineId, userId },
  });

  if (!machine) {
    throw new Error(`Machine ${machineId} not found`);
  }

  const config: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passPhrase?: string;
  } = {
    host: machine.host,
    port: machine.port,
    username: machine.username,
  };

  if (machine.authMethod === "password") {
    if (!machine.encryptedPass) {
      throw new Error(`Machine ${machine.name} is missing a password`);
    }
    config.password = decrypt(machine.encryptedPass);
  } else {
    if (!machine.encryptedKey) {
      throw new Error(`Machine ${machine.name} is missing an SSH key`);
    }
    config.privateKey = decrypt(machine.encryptedKey);
    if (machine.passPhrase) {
      config.passPhrase = decrypt(machine.passPhrase);
    }
  }

  return config;
}

// ─── SSH Helpers ────────────────────────────────────────────────

/**
 * Create a fresh SSH client and connect. Returns a cleanup function.
 */
async function connect(
  machineId: string,
  userId: string,
): Promise<{
  ssh: NodeSSH;
  disconnect: () => void;
}> {
  const config = await resolveConnectionConfig(machineId, userId);
  const ssh = new NodeSSH();

  await ssh.connect({
    ...config,
    readyTimeout: CONNECT_TIMEOUT,
    tryKeyboard: false,
  });

  return {
    ssh,
    disconnect: () => {
      try {
        ssh.dispose();
      } catch (err) {
        console.error("Failed to dispose SSH connection:", err);
      }
    },
  };
}

/**
 * Truncate output to max bytes, preserving line boundaries.
 */
export function truncateOutput(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }

  // Truncate to nearest line boundary under the limit
  const raw = Buffer.from(text, "utf8")
    .slice(0, maxBytes - 80)
    .toString("utf8");
  const lastNewline = raw.lastIndexOf("\n");
  const truncated = raw.slice(0, lastNewline > 0 ? lastNewline : raw.length);

  return {
    text: `${truncated}\n\n[output truncated. exceeded ${maxBytes} byte limit]`,
    truncated: true,
  };
}

// ─── SFTP Helpers ───────────────────────────────────────────────

/**
 * Get an SFTP session from an SSH connection.
 */
async function getSftp(ssh: NodeSSH): Promise<SFTPWrapper> {
  // requestSFTP() exists on NodeSSH but the types don't expose it cleanly
  return ssh.requestSFTP();
}

/**
 * Read a file via SFTP. Uses a promise-based wrapper around the callback API.
 */
function sftpRead(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Write raw bytes to a file via SFTP.
 */
function sftpWriteBuffer(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Whether the SFTP session died on the bytes the server sent rather than on what
 * was asked of it.
 *
 * A machine whose profile prints a banner into the SFTP channel kills the
 * session before its first packet, and ssh2 reads the text as a packet length.
 */
function isBrokenSftpSession(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Invalid packet length|exceeds max length of \d+/.test(message);
}

/**
 * Run an SFTP operation, and the same work as a shell request when the session
 * is dead. The shell reaches the same files without the subsystem.
 */
async function withSftpFallback(
  ssh: NodeSSH,
  operation: (sftp: SFTPWrapper) => Promise<void>,
  fallback: () => ShellRequest,
): Promise<void> {
  try {
    await operation(await getSftp(ssh));
  } catch (err) {
    // The fallback speaks POSIX, so a machine that is not one keeps its own
    // error.
    if (!isBrokenSftpSession(err) || (await resolvePlatform(ssh)) !== "posix") throw err;

    console.error("SFTP session is unusable, doing the work over the shell:", err);

    const { request, stdin } = fallback();
    const result = await ssh.execCommand(request, { stdin });
    if (result.code !== 0) {
      throw new Error(
        `The shell fallback failed: ${result.stderr || `exit code ${result.code ?? "unknown"}`}`,
      );
    }
  }
}

/**
 * Stat a path via SFTP.
 */
function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

/**
 * Create a single directory via SFTP.
 */
function sftpMkdir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Stat a path via SFTP, resolving `null` when it does not exist.
 *
 * A missing path is this probe's answer, not a failure, so the error is turned
 * into `null` at the callback rather than thrown and caught.
 */
function sftpTryStat(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err) resolve(null);
      else resolve(stats);
    });
  });
}

/**
 * Create a directory and any missing parents.
 *
 * SFTP's mkdir is not recursive, so walk down one segment at a time. An
 * ancestor that already exists is the desired end state, not a failure.
 */
async function sftpMkdirRecursive(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const segments = dirPath.split("/").filter(Boolean);
  let current = dirPath.startsWith("/") ? "" : ".";

  for (const segment of segments) {
    current = `${current}/${segment}`;
    try {
      await sftpMkdir(sftp, current);
    } catch (err) {
      // Only an existing directory is acceptable; permissions, read-only
      // filesystems and I/O errors must surface.
      if (!(await sftpTryStat(sftp, current))) {
        throw err;
      }
    }
  }
}

/**
 * Read the first `maxBytes` of a file via SFTP.
 */
function sftpReadHead(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, "r", (openErr, handle) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      const buffer = Buffer.alloc(maxBytes);
      sftp.read(handle, buffer, 0, maxBytes, 0, (readErr, bytesRead) => {
        sftp.close(handle, (closeErr) => {
          if (readErr) {
            reject(readErr);
          } else if (closeErr) {
            reject(closeErr);
          } else {
            resolve(buffer.subarray(0, bytesRead));
          }
        });
      });
    });
  });
}

/**
 * List directory via SFTP.
 */
function sftpListDir(sftp: SFTPWrapper, path: string): Promise<SftpListEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(err);
      else {
        resolve(
          list.map((entry) => ({
            name: entry.filename,
            type: entry.longname.startsWith("d") ? "directory" : "file",
            size: entry.attrs.size,
            modified: new Date(entry.attrs.mtime * 1000),
          })),
        );
      }
    });
  });
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Which shell this machine's exec requests land in.
 *
 * One probe per command, on the connection that command already opened. A probe
 * that cannot answer leaves the machine as POSIX, which is how every machine was
 * treated before Windows was handled.
 */
async function resolvePlatform(ssh: NodeSSH): Promise<RemotePlatform> {
  try {
    const probe = await ssh.execCommand(PLATFORM_PROBE);
    return parsePlatformProbe(probe.stdout ?? "", probe.code ?? null);
  } catch (err) {
    console.error("Failed to probe the remote shell, assuming POSIX:", err);
    return "posix";
  }
}

/**
 * Execute a command on a remote machine via SSH.
 * Connects, runs the command, collects output, disconnects.
 */
export async function executeCommand(
  machineId: string,
  userId: string,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? MAX_OUTPUT_BYTES;

  const { ssh, disconnect } = await connect(machineId, userId);

  let timedOut = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  try {
    const platform = await resolvePlatform(ssh);
    const { request, stdin } = buildShellRequest(platform, command, options);

    const execPromise = ssh.execCommand(request, { stdin });

    // Race against a timer for timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        // Force-destroy the underlying ssh2 connection so the pending exec
        // channel emits 'close' and the exec promise settles. dispose() only
        // calls end() (graceful shutdown) which may not close the socket
        // immediately, leaving the exec promise pending forever.
        const rawConnection = (ssh as { connection?: SSH2Client }).connection;
        if (rawConnection) {
          try {
            rawConnection.destroy();
          } catch (destroyErr) {
            console.error("Failed to destroy SSH connection on timeout:", destroyErr);
          }
        }
        reject(new Error(`Command timed out after ${timeout}s`));
      }, timeout * 1000);
    });

    const result = (await Promise.race([execPromise, timeoutPromise])) as {
      stdout: string;
      stderr: string;
      code: number | null;
      signal: string | null;
    };

    const stdoutTruncated = truncateOutput(result.stdout ?? "", maxOutput);
    const stderrTruncated = truncateOutput(result.stderr ?? "", maxOutput);

    return {
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      timedOut: false,
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    };
  } catch (err) {
    // Options the remote shell cannot take are the caller's mistake: the command
    // never ran, so there is no result to report.
    if (err instanceof InvalidExecOptionsError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: timedOut
        ? `Command timed out after ${timeout}s. Increase the timeout parameter for longer commands.`
        : message,
      exitCode: null,
      signal: null,
      timedOut,
      truncated: false,
    };
  } finally {
    if (timerId) clearTimeout(timerId);
    disconnect();
  }
}

/**
 * Test SSH connectivity for a machine.
 */
export async function testConnection(
  machineId: string,
  userId: string,
): Promise<{
  ok: boolean;
  message: string;
  hostname?: string;
}> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    // `hostname` is a command under both login shells, so the check needs no
    // platform probe of its own.
    const result = await ssh.execCommand("hostname");

    const hostname = result.stdout?.trim()?.split("\n")?.[0];

    const res: { ok: boolean; message: string; hostname?: string } = {
      ok: true,
      message: "Connected successfully",
    };
    if (hostname) res.hostname = hostname;
    return res;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    disconnect();
  }
}

/**
 * Read the first `maxBytes` of a file on a remote machine via SFTP.
 *
 * Image detection only needs the file's header. Reading it separately keeps a
 * text read from pulling the whole file down twice.
 */
export async function readFileHead(
  machineId: string,
  userId: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    return await sftpReadHead(sftp, filePath, maxBytes);
  } finally {
    disconnect();
  }
}

/**
 * Read a file from a remote machine via SFTP, in full.
 *
 * Callers that hand the content back to the remote machine (editing) must use
 * this rather than the truncating {@link readFile}. writing a truncated copy
 * back would destroy the rest of the file.
 */
export async function readFileRaw(
  machineId: string,
  userId: string,
  filePath: string,
): Promise<Buffer> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    return await sftpRead(sftp, filePath);
  } finally {
    disconnect();
  }
}

/**
 * Read a remote file for a transfer into the workspace.
 *
 * Stats before reading: a directory or a file the workspace cannot hold must
 * be rejected before its bytes are pulled into the app's memory.
 */
export async function readFileForTransfer(
  machineId: string,
  userId: string,
  filePath: string,
  maxBytes: number = MAX_TRANSFER_BYTES,
): Promise<{ buffer: Buffer; size: number }> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    const stats = await sftpStat(sftp, filePath);

    if (stats.isDirectory()) {
      throw new Error(`${filePath} is a directory, not a file`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `${filePath} is ${formatBytes(stats.size)}, over the ${formatBytes(maxBytes)} transfer limit`,
      );
    }

    const buffer = await sftpRead(sftp, filePath);
    return { buffer, size: buffer.length };
  } finally {
    disconnect();
  }
}

/**
 * Stat a path on a remote machine via SFTP.
 */
export async function statFile(
  machineId: string,
  userId: string,
  filePath: string,
): Promise<SftpStatResult> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    const stats = await sftpStat(sftp, filePath);

    return {
      type: stats.isDirectory() ? "directory" : "file",
      size: stats.size,
      modified: new Date(stats.mtime * 1000),
    };
  } finally {
    disconnect();
  }
}

/**
 * Create a directory (and any missing parents) on a remote machine via SFTP.
 */
export async function createDirectory(
  machineId: string,
  userId: string,
  dirPath: string,
): Promise<{ ok: boolean }> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    await withSftpFallback(
      ssh,
      (sftp) => sftpMkdirRecursive(sftp, dirPath),
      () => buildMkdirRequest(dirPath),
    );
    return { ok: true };
  } finally {
    disconnect();
  }
}

/**
 * Write bytes to a file on a remote machine, over SFTP or the shell.
 */
async function writeRemoteFile(
  machineId: string,
  userId: string,
  filePath: string,
  content: Buffer,
): Promise<void> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    await withSftpFallback(
      ssh,
      (sftp) => sftpWriteBuffer(sftp, filePath, content),
      () => buildWriteRequest(filePath, content),
    );
  } finally {
    disconnect();
  }
}

/**
 * Write content to a file on a remote machine, replacing what it held.
 */
export async function writeFile(
  machineId: string,
  userId: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean }> {
  await writeRemoteFile(machineId, userId, filePath, Buffer.from(content, "utf8"));
  return { ok: true };
}

/**
 * Write raw bytes to a file on a remote machine.
 *
 * The counterpart to {@link readFileForTransfer}: arbitrary bytes survive, which
 * is what an upload needs and what a text write must not lose either.
 */
export async function writeFileBuffer(
  machineId: string,
  userId: string,
  filePath: string,
  content: Buffer,
): Promise<{ ok: boolean; size: number }> {
  await writeRemoteFile(machineId, userId, filePath, content);
  return { ok: true, size: content.length };
}

/**
 * List directory contents on a remote machine via SFTP.
 */
export async function listDirectory(
  machineId: string,
  userId: string,
  dirPath: string,
): Promise<SftpListEntry[]> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    return sftpListDir(sftp, dirPath);
  } finally {
    disconnect();
  }
}
