/**
 * What is listening inside a workspace's container.
 *
 * The sandbox image has neither `ss` nor `lsof`, so the port list comes from
 * the kernel's own tables: `/proc/net/tcp{,6}` for the sockets, then the fd
 * symlinks to find the process that owns one, which is also where the command
 * line and the working directory come from.
 *
 * Parsing lives here and is pure; the shell that produces the text is one
 * command constant each, so a fixture is the whole test surface.
 */

/** One listening TCP socket, as the kernel reports it. */
export interface ListeningSocket {
  port: number;
  address: string;
  inode: string;
  /** Bound to a loopback address, so nothing outside the container can reach it. */
  loopback: boolean;
}

/** One listening port with the process behind it. */
export interface PortEntry {
  port: number;
  address: string;
  loopback: boolean;
  pid: number | null;
  command: string | null;
  /** Absolute path inside the container. */
  cwd: string | null;
}

/** The listening sockets of both TCP tables. */
export const READ_SOCKETS_COMMAND = "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null";

/** Every open descriptor in the container, one process directory at a time. */
export const LIST_FDS_COMMAND = "ls -l /proc/[0-9]*/fd 2>/dev/null";

/** Longest command line kept for display. */
const MAX_COMMAND_LENGTH = 200;

/** Docker's embedded resolver listens on loopback in every container. */
const EMBEDDED_DNS = "127.0.0.11";

const LISTENING = "0A";

function decodeIpv4(hex: string): string {
  // Little-endian: the first byte of the text is the last byte of the address.
  const bytes = [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return bytes.join(".");
}

/** `/proc/net/tcp6` words are little-endian, like the v4 form. */
function decodeIpv6(hex: string): string {
  const bytes: number[] = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    // Each 32-bit word is written little-endian, like the v4 form.
    for (let index = 3; index >= 0; index -= 1) {
      bytes.push(Number.parseInt(chunk.slice(index * 2, index * 2 + 2), 16));
    }
  }

  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    groups.push((((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toString(16));
  }

  const zeroPrefix = bytes.slice(0, 10).every((byte) => byte === 0);
  if (zeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join(".")}`;
  }
  const compressed = groups.join(":");
  return compressed === "0:0:0:0:0:0:0:1" ? "::1" : compressed;
}

/** `0100007F:1F90` in the v4 table, 32 hex characters of address in the v6 table. */
function parseAddress(field: string): { address: string; port: number } | null {
  const [hex, portText] = field.split(":");
  if (!hex || !portText) return null;

  const port = Number.parseInt(portText, 16);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  if (hex.length === 8) return { address: decodeIpv4(hex), port };
  if (hex.length === 32) return { address: decodeIpv6(hex), port };
  return null;
}

/** Whether an address can only be reached from inside the container. */
export function isLoopbackAddress(address: string): boolean {
  return address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127.");
}

/**
 * The listening sockets in `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * A port bound on both stacks appears twice; the caller merges it. Docker's
 * resolver is skipped because it is loopback and listens in every container.
 */
export function parseProcNetTcp(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];

  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== LISTENING) continue;

    const local = parseAddress(fields[1] ?? "");
    const inode = fields[9];
    if (!local || !inode || !/^\d+$/.test(inode)) continue;
    if (local.address === EMBEDDED_DNS) continue;

    sockets.push({
      port: local.port,
      address: local.address,
      inode,
      loopback: isLoopbackAddress(local.address),
    });
  }

  return sockets;
}

/**
 * Socket inode to owning pid, from `ls -l /proc/<pid>/fd`.
 *
 * The listing is one `ls` for the whole container, so the parse is where the
 * heading lines (`/proc/42/fd:`) matter as much as the entries.
 */
export function parseFdListing(text: string): Map<string, number> {
  const owners = new Map<string, number>();
  let pid: number | null = null;

  for (const line of text.split("\n")) {
    const heading = /^\/proc\/(\d+)\/fd:$/.exec(line.trim());
    if (heading?.[1]) {
      pid = Number(heading[1]);
      continue;
    }
    if (pid === null) continue;

    const socket = / -> socket:\[(\d+)\]$/.exec(line.trim());
    if (!socket?.[1]) continue;
    if (!owners.has(socket[1])) owners.set(socket[1], pid);
  }

  return owners;
}

/** The command that prints one line per process: pid, cwd, command line. */
export function describeProcessesCommand(pids: readonly number[]): string {
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(" ");
  if (!list) return "true";
  return (
    `for p in ${list}; do ` +
    `printf '%s\\t%s\\t' "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; ` +
    `tr '\\0' ' ' < "/proc/$p/cmdline" 2>/dev/null; ` +
    `printf '\\n'; ` +
    `done`
  );
}

export interface ProcessDetails {
  cwd: string | null;
  command: string | null;
}

/** The pid, cwd and command triplet lines `describeProcessesCommand` prints. */
export function parseProcessDetails(text: string): Map<number, ProcessDetails> {
  const details = new Map<number, ProcessDetails>();

  for (const line of text.split("\n")) {
    const [pidText, cwdText, commandText] = line.split("\t");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    const cwd = cwdText && cwdText.startsWith("/") ? cwdText : null;
    const command = (commandText ?? "").replace(/\s+/g, " ").trim();
    details.set(pid, {
      cwd,
      command: command ? command.slice(0, MAX_COMMAND_LENGTH) : null,
    });
  }

  return details;
}

/**
 * Sockets, owners and process details as one entry per port.
 *
 * A server on `0.0.0.0` and `::` is one server; the reachable address wins,
 * because that is the one a preview can connect to.
 */
export function mergePorts(options: {
  sockets: readonly ListeningSocket[];
  owners: ReadonlyMap<string, number>;
  details: ReadonlyMap<number, ProcessDetails>;
}): PortEntry[] {
  const byPort = new Map<number, PortEntry>();

  for (const socket of options.sockets) {
    const pid = options.owners.get(socket.inode) ?? null;
    const detail = pid === null ? null : options.details.get(pid);
    const entry: PortEntry = {
      port: socket.port,
      address: socket.address,
      loopback: socket.loopback,
      pid,
      command: detail?.command ?? null,
      cwd: detail?.cwd ?? null,
    };

    const seen = byPort.get(socket.port);
    if (!seen) {
      byPort.set(socket.port, entry);
      continue;
    }
    // Same port on both stacks: keep the bind a preview could reach.
    if (seen.loopback && !entry.loopback) byPort.set(socket.port, entry);
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
