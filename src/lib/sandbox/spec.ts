/**
 * The container an identity's commands run in.
 *
 * Pure, so the isolation properties are a unit test rather than something that
 * only shows up when a container misbehaves: one mount per identity, its
 * subpath equal to the identity, a user on the container and on every exec, and
 * the sandbox network.
 */

import { parseIdentity } from "./identity";
import type { SandboxConfig } from "./config";

/** A single volume mount with a per-identity subpath. */
export interface SandboxMount {
  Type: "volume";
  Source: string;
  Target: string;
  VolumeOptions: { Subpath: string };
}

export interface SandboxContainerSpec {
  name: string;
  Image: string;
  Cmd: string[];
  User: string;
  WorkingDir: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    NetworkMode: string;
    Mounts: SandboxMount[];
    Init: boolean;
    Memory: number | string;
    PidsLimit: number;
    NanoCpus: number;
    CapDrop?: string[];
    SecurityOpt?: string[];
  };
  Tty: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  AttachStdin: boolean;
  OpenStdin: boolean;
}

/** Container name for an identity. The label carries the identity itself. */
export function containerName(identity: string): string {
  return `saale-sandbox-${parseIdentity(identity)}`;
}

/** Where an identity's directory appears inside its own container. */
export function containerWorkspacePath(identity: string, config: SandboxConfig): string {
  return `${config.workspacesDir}/${parseIdentity(identity)}`;
}

/** `PATH` with the workspace's `bin` first, so `pip --user` installs are found. */
export function containerPath(identity: string, config: SandboxConfig): string {
  const home = containerWorkspacePath(identity, config);
  return [
    `${home}/.local/bin`,
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
}

/** Memory as bytes, which is what the API takes. `2g` → 2147483648. */
export function memoryBytes(memory: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(memory.trim());
  if (!match) throw new Error(`Invalid SANDBOX_MEMORY: ${memory}`);
  const factors: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  const unit = (match[2] ?? "").toLowerCase();
  return Math.round(Number(match[1]) * (factors[unit] ?? 1));
}

/** The cgroup limits the config asks for, as the create API takes them. */
export interface ContainerLimits {
  Memory: number;
  PidsLimit: number;
  NanoCpus: number;
}

export function wantedLimits(config: SandboxConfig): ContainerLimits {
  return {
    Memory: memoryBytes(config.memory),
    PidsLimit: config.pids,
    NanoCpus: config.cpus * 1e9,
  };
}

/** The limits Docker records on a container, loosely typed: an inspect reply. */
export interface ExistingLimits {
  Memory?: number | string | undefined;
  PidsLimit?: number | string | null | undefined;
  NanoCpus?: number | string | undefined;
}

const LIMIT_FIELDS = ["Memory", "PidsLimit", "NanoCpus"] as const;

/**
 * Which limits an existing container disagrees with the config on.
 *
 * Docker fixes `HostConfig` at create time and cannot change a memory limit on
 * a running container, so anything listed here needs the container replaced
 * before the new setting takes effect. Reported as `field: have → want`.
 */
export function limitDrift(existing: ExistingLimits | undefined, config: SandboxConfig): string[] {
  if (!existing) return [];
  const want = wantedLimits(config);
  const drift: string[] = [];
  for (const field of LIMIT_FIELDS) {
    const have = Number(existing[field] ?? 0);
    if (!Number.isFinite(have) || have !== want[field]) {
      drift.push(`${field}: ${have} → ${want[field]}`);
    }
  }
  return drift;
}

/**
 * Create options for one identity's container.
 *
 * `SANDBOX_USER` is applied to the container and to every exec, so a command
 * can never run as an account the operator did not choose. The capability drop
 * follows from that choice: root keeps Docker's default set so package installs
 * work, `agent` never has the caps to try.
 */
export function containerSpec(identity: string, config: SandboxConfig): SandboxContainerSpec {
  const id = parseIdentity(identity);
  const home = containerWorkspacePath(id, config);
  const untrusted = config.user !== "root";

  return {
    name: containerName(id),
    Image: config.image,
    Cmd: ["sleep", "infinity"],
    User: config.user,
    WorkingDir: home,
    Env: [`HOME=${home}`, `PATH=${containerPath(id, config)}`],
    Labels: { "saale.sandbox": id },
    HostConfig: {
      NetworkMode: config.network,
      Mounts: [
        {
          Type: "volume",
          Source: config.volume,
          Target: home,
          VolumeOptions: { Subpath: id },
        },
      ],
      Init: true,
      ...wantedLimits(config),
      ...(untrusted ? { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] } : {}),
    },
    Tty: false,
    AttachStdout: false,
    AttachStderr: false,
    AttachStdin: false,
    OpenStdin: false,
  };
}
