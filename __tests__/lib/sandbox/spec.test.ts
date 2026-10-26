import { describe, expect, it, vi } from "vitest";
import { sandboxConfig, type SandboxConfig } from "@/lib/sandbox/config";
import {
  containerName,
  containerPath,
  containerSpec,
  containerWorkspacePath,
  limitDrift,
  memoryBytes,
} from "@/lib/sandbox/spec";
import { InvalidSandboxIdentityError } from "@/lib/sandbox/identity";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...sandboxConfig(), ...overrides };
}

describe("containerSpec", () => {
  const spec = containerSpec("user-abc123", config());

  it("mounts exactly one directory: this identity's subpath, at its own path", () => {
    expect(spec.HostConfig.Mounts).toHaveLength(1);
    expect(spec.HostConfig.Mounts[0]).toEqual({
      Type: "volume",
      Source: "saale_workspaces",
      Target: "/w/user-abc123",
      VolumeOptions: { Subpath: "user-abc123" },
    });
  });

  it("never mounts the volume root, so the other tenants are not at any path", () => {
    for (const mount of spec.HostConfig.Mounts) {
      expect(mount.Target).not.toBe("/w");
      expect(mount.Target.startsWith("/w/")).toBe(true);
    }
  });

  it("runs as a named user and works in the mounted directory", () => {
    expect(spec.User).toBe("root");
    expect(spec.WorkingDir).toBe("/w/user-abc123");
    expect(spec.Env).toContain("HOME=/w/user-abc123");
    expect(containerPath("user-abc123", config()).startsWith("/w/user-abc123/.local/bin:")).toBe(
      true,
    );
  });

  it("joins the sandbox network, not the compose project's", () => {
    expect(spec.HostConfig.NetworkMode).toBe("saale-sandbox");
  });

  it("takes its limits from the config", () => {
    const limited = containerSpec("user-abc123", config({ memory: "512m", pids: 64, cpus: 1 }));
    expect(limited.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(limited.HostConfig.PidsLimit).toBe(64);
    expect(limited.HostConfig.NanoCpus).toBe(1e9);
    expect(limited.HostConfig.Init).toBe(true);
  });

  it("keeps Docker's default capabilities as root, so package installs work", () => {
    expect(spec.HostConfig.CapDrop).toBeUndefined();
    expect(spec.HostConfig.SecurityOpt).toBeUndefined();
  });

  it("drops every capability when commands run as the unprivileged account", () => {
    const tight = containerSpec("user-abc123", config({ user: "agent" }));
    expect(tight.User).toBe("agent");
    expect(tight.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(tight.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
  });

  it("labels the container with the identity, which is what sweeping reads", () => {
    expect(spec.Labels["saale.sandbox"]).toBe("user-abc123");
    expect(spec.name).toBe("saale-sandbox-user-abc123");
  });

  it("keeps the container out of the app's compose project", () => {
    expect(spec.Labels["com.docker.compose.project"]).toBe("");
  });

  it("idles until a command arrives", () => {
    expect(spec.Cmd).toEqual(["sleep", "infinity"]);
    expect(containerName("council-abcd1234")).toBe("saale-sandbox-council-abcd1234");
  });

  it("refuses a malformed identity instead of building a mount for it", () => {
    expect(() => containerSpec("user-../other", config())).toThrow(InvalidSandboxIdentityError);
    expect(() => containerName("/workspaces/user-a")).toThrow(InvalidSandboxIdentityError);
    expect(() => containerWorkspacePath("user-a/b", config())).toThrow(InvalidSandboxIdentityError);
  });
});

describe("limitDrift", () => {
  it("reports nothing when the container already carries the configured limits", () => {
    const spec = containerSpec("user-abc", config({ memory: "8g", pids: 512, cpus: 2 }));
    expect(limitDrift(spec.HostConfig, config({ memory: "8g", pids: 512, cpus: 2 }))).toEqual([]);
  });

  it("names every limit that disagrees, as have → want", () => {
    const old = containerSpec("user-abc", config({ memory: "2g", pids: 512, cpus: 2 }));
    const drift = limitDrift(old.HostConfig, config({ memory: "8g", pids: 1024, cpus: 2 }));
    expect(drift).toEqual([`Memory: ${2 * 1024 ** 3} → ${8 * 1024 ** 3}`, "PidsLimit: 512 → 1024"]);
  });

  it("treats a container without limits as drifted, and an absent reply as unknown", () => {
    expect(limitDrift({}, config({ memory: "8g", pids: 512, cpus: 2 }))).toHaveLength(3);
    // Docker reports the limits as numbers; a numeric string still compares.
    expect(limitDrift({ Memory: String(8 * 1024 ** 3) }, config({ memory: "8g" }))).toEqual([
      "PidsLimit: 0 → 512",
      "NanoCpus: 0 → 2000000000",
    ]);
    expect(limitDrift(undefined, config())).toEqual([]);
  });
});

describe("memoryBytes", () => {
  it("reads the units an operator writes", () => {
    expect(memoryBytes("2g")).toBe(2 * 1024 ** 3);
    expect(memoryBytes("512m")).toBe(512 * 1024 ** 2);
    expect(memoryBytes("64k")).toBe(64 * 1024);
    expect(memoryBytes("1048576")).toBe(1048576);
    expect(memoryBytes("1.5g")).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it("refuses a value it cannot interpret rather than guessing", () => {
    expect(() => memoryBytes("lots")).toThrow(/Invalid SANDBOX_MEMORY/);
    expect(() => memoryBytes("")).toThrow(/Invalid SANDBOX_MEMORY/);
  });
});

describe("sandboxConfig", () => {
  it("falls back to the compose defaults", () => {
    vi.stubEnv("SANDBOX_URL", "");
    vi.stubEnv("SANDBOX_VOLUME", "");
    const value = sandboxConfig();
    expect(value.url).toBeUndefined();
    expect(value.volume).toBe("saale_workspaces");
    expect(value.workspacesDir).toBe("/w");
    expect(value.user).toBe("root");
    expect(value.memory).toBe("4g");
    vi.unstubAllEnvs();
  });

  it("keeps a bad number from arming something absurd, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SANDBOX_MEMORY", "1g");
    vi.stubEnv("SANDBOX_PIDS", "-5");

    expect(sandboxConfig().pids).toBe(512);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("SANDBOX_PIDS"));
    error.mockRestore();
    vi.unstubAllEnvs();
  });
});
