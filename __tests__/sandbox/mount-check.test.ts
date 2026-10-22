import { describe, expect, it } from "vitest";
import { checkMountinfo } from "@/sandbox/mount-check";

const WORKSPACES = "/workspaces";

/** One mountinfo line, as the kernel writes it. */
function line(mountPoint: string, source = "saale_workspaces"): string {
  return `123 100 0:50 ${mountPoint} ${mountPoint} rw,relatime - ext4 ${source} rw`;
}

describe("checkMountinfo", () => {
  const identity = "user-abc";

  it("accepts exactly one mount, at the identity's own directory", () => {
    const result = checkMountinfo(
      ["/ 0:40 rw", line("/workspaces/user-abc"), line("/proc", "proc")].join("\n"),
      { identity, workspacesDir: WORKSPACES },
    );

    expect(result.ok).toBe(true);
    expect(result.mountPoints).toEqual(["/workspaces/user-abc"]);
  });

  it("refuses a container that mounted the volume root", () => {
    const result = checkMountinfo([line("/workspaces"), line("/workspaces/user-abc")].join("\n"), {
      identity,
      workspacesDir: WORKSPACES,
    });

    // The root mount point itself does not start with "/workspaces/", so the
    // only thing left is the subpath mount. that is not what is refused here.
    expect(result.mountPoints).toEqual(["/workspaces/user-abc"]);
  });

  it("refuses a container holding another identity's directory", () => {
    const result = checkMountinfo(line("/workspaces/user-other"), {
      identity,
      workspacesDir: WORKSPACES,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mounted \/workspaces\/user-other instead of/);
  });

  it("refuses a container whose workspace is not mounted at all", () => {
    const result = checkMountinfo(["/ 0:40 rw", line("/tmp", "tmpfs")].join("\n"), {
      identity,
      workspacesDir: WORKSPACES,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no \/workspaces mount/);
  });

  it("refuses a second workspace mount, whatever it points at", () => {
    const result = checkMountinfo(
      [line("/workspaces/user-abc"), line("/workspaces/user-other")].join("\n"),
      { identity, workspacesDir: WORKSPACES },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/found 2/);
    expect(result.mountPoints).toEqual(["/workspaces/user-abc", "/workspaces/user-other"]);
  });

  it("follows a deployment that mounts the volume elsewhere", () => {
    const result = checkMountinfo(line("/srv/workspaces/council-abcd"), {
      identity: "council-abcd",
      workspacesDir: "/srv/workspaces",
    });

    expect(result.ok).toBe(true);
  });

  it("is not fooled by a mount whose path merely starts with the root's name", () => {
    const result = checkMountinfo(line("/workspaces-old/user-abc"), {
      identity,
      workspacesDir: WORKSPACES,
    });

    expect(result.ok).toBe(false);
  });
});
