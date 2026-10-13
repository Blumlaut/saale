import { beforeEach, describe, expect, it, vi } from "vitest";

// The sandbox is a thin guard over the Open Terminal operations, so the backend
// is replaced here: what is under test is which paths reach the container.
const terminalOps = {
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

vi.mock("@/lib/terminal/operations", () => ({
  createTerminalOperations: vi.fn(() => terminalOps),
}));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: () => true,
  deriveOpenTerminalUsername: (id: string) => `u${id}`,
  getTerminalHomeDir: (id: string) => `/home/u${id}`,
}));

import { createTerminalOperations } from "@/lib/terminal/operations";
import {
  CouncilSandboxEscapeError,
  createCouncilSandbox,
  normalizeSandboxPath,
  resolveSandboxPath,
  type CouncilSandbox,
} from "@/lib/council/sandbox";
import { SANDBOX_KEY_LENGTH } from "@/lib/council/config";

const ROOT = "/home/uabcd1234";

describe("normalizeSandboxPath", () => {
  it("keeps a path inside the sandbox as an absolute path", () => {
    expect(normalizeSandboxPath(ROOT, "/home/uabcd1234/notes.md")).toBe("/home/uabcd1234/notes.md");
  });

  it("resolves a relative path from the sandbox root", () => {
    expect(normalizeSandboxPath(ROOT, "notes/plan.md")).toBe("/home/uabcd1234/notes/plan.md");
  });

  it("collapses redundant segments without leaving the sandbox", () => {
    expect(normalizeSandboxPath(ROOT, "./a//b/../c")).toBe("/home/uabcd1234/a/c");
    expect(normalizeSandboxPath(ROOT, "/home/uabcd1234/./a/../a/x")).toBe("/home/uabcd1234/a/x");
  });

  it("accepts the root itself", () => {
    expect(normalizeSandboxPath(ROOT, "/home/uabcd1234")).toBe(ROOT);
    expect(normalizeSandboxPath(ROOT, ".")).toBe(ROOT);
    expect(normalizeSandboxPath(ROOT, "")).toBe(ROOT);
  });

  it("refuses any path that climbs out of the sandbox", () => {
    expect(() => normalizeSandboxPath(ROOT, "../other")).toThrow(CouncilSandboxEscapeError);
    expect(() => normalizeSandboxPath(ROOT, "/home/uabcd1234/../../user")).toThrow(
      CouncilSandboxEscapeError,
    );
    expect(() => normalizeSandboxPath(ROOT, "/etc/passwd")).toThrow(CouncilSandboxEscapeError);
    expect(() => normalizeSandboxPath(ROOT, "/home/uabcd1234/../uabcd1235")).toThrow(
      CouncilSandboxEscapeError,
    );
  });

  it("refuses a sibling whose name merely starts with the root", () => {
    // A prefix test without the separator would let this through.
    expect(() => normalizeSandboxPath("/home/abc", "/home/abc-secrets/key")).toThrow(
      CouncilSandboxEscapeError,
    );
  });

  it("refuses a path containing a null byte", () => {
    expect(() => normalizeSandboxPath(ROOT, "/home/uabcd1234/a\0b")).toThrow(
      CouncilSandboxEscapeError,
    );
  });

  it("is not fooled by a root with a trailing slash", () => {
    expect(normalizeSandboxPath(`${ROOT}/`, "a.txt")).toBe(`${ROOT}/a.txt`);
  });
});

describe("resolveSandboxPath", () => {
  it("reports a path inside the sandbox as inside", () => {
    expect(resolveSandboxPath(ROOT, "a/b.txt")).toEqual({
      path: "/home/uabcd1234/a/b.txt",
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
    sandbox = createCouncilSandbox({
      councilId: "c1",
      sandboxKey: "abcd1234",
      userId: "u1",
    });
  });

  it("runs the container as the council's own account, in its own home", () => {
    expect(sandbox.home).toBe("/home/uabcd1234");
    expect(createTerminalOperations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "abcd1234", cwd: "/home/uabcd1234" }),
    );
  });

  it("never forwards a GitHub token or any other extra environment", () => {
    const options = vi.mocked(createTerminalOperations).mock.calls[0]?.[0];
    expect(options?.extraEnv).toBeUndefined();
  });

  it("passes a path inside the sandbox through", async () => {
    await sandbox.operations.read.readFile("/home/uabcd1234/a.txt");
    expect(terminalOps.read.readFile).toHaveBeenCalledWith("/home/uabcd1234/a.txt");
  });

  it("normalizes before the operation, so the container sees a clean path", async () => {
    await sandbox.operations.write.writeFile("notes/../a.txt", "x");
    expect(terminalOps.write.writeFile).toHaveBeenCalledWith("/home/uabcd1234/a.txt", "x");
  });

  it("refuses a read outside the sandbox and blocks the call", async () => {
    await expect(sandbox.operations.read.readFile("/home/user/.ssh/id_rsa")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(terminalOps.read.readFile).not.toHaveBeenCalled();
  });

  it("refuses a write outside the sandbox and blocks the call", async () => {
    await expect(sandbox.operations.write.writeFile("../../user/x.txt", "x")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(terminalOps.write.writeFile).not.toHaveBeenCalled();
  });

  it("refuses an edit's access check outside the sandbox", async () => {
    await expect(sandbox.operations.edit.access("/etc/shadow")).rejects.toThrow(
      CouncilSandboxEscapeError,
    );
    expect(terminalOps.edit.access).not.toHaveBeenCalled();
  });

  it("clamps a cwd outside the sandbox instead of failing the command", async () => {
    // bash needs a cwd to run in; the sandbox root is the only safe answer.
    await sandbox.operations.bash.exec("ls", "/home/user", {
      onData: () => {},
    });
    expect(terminalOps.bash.exec).toHaveBeenCalledWith("ls", "/home/uabcd1234", expect.anything());
  });

  it("keeps a cwd inside the sandbox", async () => {
    await sandbox.operations.bash.exec("ls", "/home/uabcd1234/src", { onData: () => {} });
    expect(terminalOps.bash.exec).toHaveBeenCalledWith(
      "ls",
      "/home/uabcd1234/src",
      expect.anything(),
    );
  });
});

describe("sandbox key length", () => {
  it("matches what Open Terminal keeps of an id", () => {
    // A longer key would be truncated by the container, so two keys could name
    // one account.
    expect(SANDBOX_KEY_LENGTH).toBe(8);
  });
});
