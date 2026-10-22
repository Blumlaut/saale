import { beforeEach, describe, expect, it, vi } from "vitest";

// The sandbox is a thin guard over the workspace operations, so the backend is
// replaced here: what is under test is which paths and which identity reach it.
const workspaceOps = {
  read: {
    readFile: vi.fn(async (path: string) => Buffer.from(`content-of:${path}`)),
    access: vi.fn(async () => undefined),
    detectImageMimeType: vi.fn(async () => null),
  },
  write: {
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  },
  edit: {
    readFile: vi.fn(async (path: string) => Buffer.from(`content-of:${path}`)),
    writeFile: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
  },
  bash: {
    exec: vi.fn(async () => ({ exitCode: 0 })),
  },
};

vi.mock("@/lib/sandbox/operations", () => ({
  createSandboxOperations: vi.fn(() => workspaceOps),
}));

import { createSandboxOperations } from "@/lib/sandbox/operations";
import {
  CouncilSandboxEscapeError,
  createCouncilSandbox,
  normalizeSandboxPath,
  resolveSandboxPath,
  type CouncilSandbox,
} from "@/lib/council/sandbox";
import { SANDBOX_KEY_LENGTH } from "@/lib/council/config";

const ROOT = "/workspaces/council-abcd1234";

describe("normalizeSandboxPath", () => {
  it("keeps a path inside the sandbox as an absolute path", () => {
    expect(normalizeSandboxPath(ROOT, `${ROOT}/notes.md`)).toBe(`${ROOT}/notes.md`);
  });

  it("resolves a relative path from the sandbox root", () => {
    expect(normalizeSandboxPath(ROOT, "notes/plan.md")).toBe(`${ROOT}/notes/plan.md`);
  });

  it("collapses redundant segments without leaving the sandbox", () => {
    expect(normalizeSandboxPath(ROOT, "./a//b/../c")).toBe(`${ROOT}/a/c`);
    expect(normalizeSandboxPath(ROOT, `${ROOT}/./a/../a/x`)).toBe(`${ROOT}/a/x`);
  });

  it("accepts the root itself", () => {
    expect(normalizeSandboxPath(ROOT, ROOT)).toBe(ROOT);
    expect(normalizeSandboxPath(ROOT, ".")).toBe(ROOT);
    expect(normalizeSandboxPath(ROOT, "")).toBe(ROOT);
  });

  it("refuses any path that climbs out of the sandbox", () => {
    expect(() => normalizeSandboxPath(ROOT, "../other")).toThrow(CouncilSandboxEscapeError);
    expect(() => normalizeSandboxPath(ROOT, `${ROOT}/../../workspaces`)).toThrow(
      CouncilSandboxEscapeError,
    );
    expect(() => normalizeSandboxPath(ROOT, "/etc/passwd")).toThrow(CouncilSandboxEscapeError);
    expect(() => normalizeSandboxPath(ROOT, `${ROOT}-other/x`)).toThrow(CouncilSandboxEscapeError);
  });

  it("refuses a sibling whose name merely starts with the root", () => {
    // A prefix test without the separator would let this through.
    expect(() => normalizeSandboxPath("/home/abc", "/home/abc-secrets/key")).toThrow(
      CouncilSandboxEscapeError,
    );
  });

  it("refuses a path containing a null byte", () => {
    expect(() => normalizeSandboxPath(ROOT, `${ROOT}/a\0b`)).toThrow(CouncilSandboxEscapeError);
  });

  it("is not fooled by a root with a trailing slash", () => {
    expect(normalizeSandboxPath(`${ROOT}/`, "a.txt")).toBe(`${ROOT}/a.txt`);
  });
});

describe("resolveSandboxPath", () => {
  it("reports a path inside the sandbox as inside", () => {
    expect(resolveSandboxPath(ROOT, "a/b.txt")).toEqual({
      path: `${ROOT}/a/b.txt`,
      inside: true,
    });
  });

  it("reports a path that leaves the sandbox as outside, without throwing", () => {
    // The cwd clamp needs to ask the question, not handle the exception.
    expect(resolveSandboxPath(ROOT, "/etc")).toEqual({ path: ROOT, inside: false });
    expect(resolveSandboxPath(ROOT, "../sibling")).toEqual({ path: ROOT, inside: false });
  });
});

describe("createCouncilSandbox", () => {
  let sandbox: CouncilSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
    sandbox = createCouncilSandbox({
      councilId: "c1",
      sandboxKey: "abcd1234",
      env: { GH_TOKEN: "owner-token" },
    });
  });

  it("runs in the council's own directory, as the council's own identity", () => {
    expect(sandbox.home).toBe(ROOT);
    expect(createSandboxOperations).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "council-abcd1234", root: ROOT }),
    );
  });

  it("gives the members the owner's variables and nothing else", () => {
    const options = vi.mocked(createSandboxOperations).mock.calls[0]?.[0];
    expect(options?.env).toEqual({ GH_TOKEN: "owner-token" });
  });

  it("passes a path inside the sandbox through", async () => {
    await sandbox.operations.read.readFile(`${ROOT}/a.txt`);
    expect(workspaceOps.read.readFile).toHaveBeenCalledWith(`${ROOT}/a.txt`);
  });

  it("normalizes before the operation, so the container sees a clean path", async () => {
    await sandbox.operations.write.writeFile("notes/../a.txt", "x");
    expect(workspaceOps.write.writeFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, "x");
  });

  it("refuses a read outside the sandbox and blocks the call", async () => {
    await expect(sandbox.operations.read.readFile("/home/user/.ssh/id_rsa")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(workspaceOps.read.readFile).not.toHaveBeenCalled();
  });

  it("refuses a write outside the sandbox and blocks the call", async () => {
    await expect(sandbox.operations.write.writeFile("../../user/x.txt", "x")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(workspaceOps.write.writeFile).not.toHaveBeenCalled();
  });

  it("refuses an edit's access check outside the sandbox", async () => {
    await expect(sandbox.operations.edit.access("/etc/shadow")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(workspaceOps.edit.access).not.toHaveBeenCalled();
  });

  it("clamps a cwd outside the sandbox instead of failing the command", async () => {
    // bash needs a cwd to run in; the sandbox root is the only safe answer.
    await sandbox.operations.bash.exec("ls", "/home/user", {
      onData: () => {},
    });
    expect(workspaceOps.bash.exec).toHaveBeenCalledWith("ls", ROOT, expect.anything());
  });

  it("keeps a cwd inside the sandbox", async () => {
    await sandbox.operations.bash.exec("ls", `${ROOT}/src`, { onData: () => {} });
    expect(workspaceOps.bash.exec).toHaveBeenCalledWith("ls", `${ROOT}/src`, expect.anything());
  });
});

describe("sandbox key length", () => {
  it("stays a short, filesystem-safe directory name", () => {
    expect(SANDBOX_KEY_LENGTH).toBe(8);
  });
});
