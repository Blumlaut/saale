/**
 * SSH client wrapper for infrastructure management.
 *
 * Per-command connect/disconnect — no persistent sessions.
 * Handles credential encryption/decryption, timeouts, and output limits.
 */

import { generateKeyPairSync } from "crypto";
import type { SFTPWrapper } from "ssh2";
import { NodeSSH } from "node-ssh";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// ─── Limits ─────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30; // seconds
const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB
const CONNECT_TIMEOUT = 10000; // 10 seconds for SSH handshake

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
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface SftpReadResult {
  content: string;
  truncated: boolean;
}

export interface SftpListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: Date;
}

// ─── Key Generation ─────────────────────────────────────────────

/**
 * Generate an ED25519 SSH key pair.
 * Uses Node.js built-in crypto module — no external dependencies.
 */
export function generateSshKeyPair(): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  // Convert PEM public key to OpenSSH format for authorized_keys
  const sshPublicKey = toOpenSshPublicKey(publicKey);

  return {
    privateKey: privateKey as string,
    publicKey: sshPublicKey,
  };
}

/**
 * Convert a PEM (SPKI) ED25519 public key to OpenSSH format.
 * OpenSSH format: "ssh-ed25519 <base64-data>"
 *
 * SPKI DER structure for ED25519:
 *   SEQUENCE (44 bytes)
 *     SEQUENCE (5 bytes) { OID 1.3.101.112 }
 *     BIT STRING (33 bytes) { 0x00 + 32-byte raw key }
 * The raw 32-byte key is at offset 12.
 */
function toOpenSshPublicKey(pemPublicKey: string): string {
  // Strip PEM headers/footers and decode base64
  const pemContent = pemPublicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const derBuffer = Buffer.from(pemContent, "base64");

  // Extract raw 32-byte ED25519 public key from DER
  const rawKey = derBuffer.slice(12, 44);

  // Build OpenSSH key data: string("ssh-ed25519") + string(raw-key)
  const keyType = Buffer.from("ssh-ed25519");
  const sshKeyData = Buffer.alloc(4 + keyType.length + 4 + rawKey.length);
  sshKeyData.writeUInt32BE(keyType.length, 0);
  keyType.copy(sshKeyData, 4);
  sshKeyData.writeUInt32BE(rawKey.length, 4 + keyType.length);
  rawKey.copy(sshKeyData, 4 + keyType.length + 4);

  return `ssh-ed25519 ${sshKeyData.toString("base64")}`;
}

// ─── Credential Resolution ──────────────────────────────────────

/**
 * Resolve SSH connection config from a stored machine record.
 * Decrypts credentials and returns a node-ssh config.
 * Requires userId for user isolation — always verify ownership before connecting.
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
    text: `${truncated}\n\n[output truncated — exceeded ${maxBytes} byte limit]`,
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
 * Write a file via SFTP.
 */
function sftpWrite(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, "utf8", (err) => {
      if (err) reject(err);
      else resolve();
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
    const execOptions: Record<string, unknown> = {};
    if (options.cwd) execOptions.cwd = options.cwd;
    if (options.env) execOptions.env = options.env;

    const execPromise = ssh.execCommand(
      command,
      execOptions as Parameters<NodeSSH["execCommand"]>[1],
    );

    // Race against a timer for timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Command timed out after ${timeout}s`));
      }, timeout * 1000);
    });

    const result = (await Promise.race([execPromise, timeoutPromise])) as {
      stdout: string;
      stderr: string;
      code: number;
    };

    const stdoutTruncated = truncateOutput(result.stdout ?? "", maxOutput);
    const stderrTruncated = truncateOutput(result.stderr ?? "", maxOutput);

    return {
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: result.code ?? null,
      timedOut: false,
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: timedOut
        ? `Command timed out after ${timeout}s. Increase the timeout parameter for longer commands.`
        : message,
      exitCode: null,
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
    const result = await ssh.execCommand("hostname && echo 'OK'");

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
 * Read a file from a remote machine via SFTP.
 */
export async function readFile(
  machineId: string,
  userId: string,
  filePath: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
): Promise<SftpReadResult> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    const buffer = await sftpRead(sftp, filePath);
    const text = buffer.toString("utf8");
    const { text: truncated, truncated: isTruncated } = truncateOutput(text, maxBytes);

    return { content: truncated, truncated: isTruncated };
  } finally {
    disconnect();
  }
}

/**
 * Write content to a file on a remote machine via SFTP.
 */
export async function writeFile(
  machineId: string,
  userId: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean }> {
  const { ssh, disconnect } = await connect(machineId, userId);

  try {
    const sftp = await getSftp(ssh);
    await sftpWrite(sftp, filePath, content);
    return { ok: true };
  } finally {
    disconnect();
  }
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
