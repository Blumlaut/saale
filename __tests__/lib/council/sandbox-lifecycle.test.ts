import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ configured: true }));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: () => hoisted.configured,
  deriveOpenTerminalUsername: (id: string) => {
    // Mirrors Open Terminal: first eight alphanumerics, prefixed with "u" when
    // the result would start with a digit.
    const cleaned = id
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 8);
    return /^[0-9]/.test(cleaned) ? `u${cleaned}` : cleaned;
  },
  getTerminalHomeDir: (id: string) => {
    const cleaned = id
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 8);
    return `/home/${/^[0-9]/.test(cleaned) ? `u${cleaned}` : cleaned}`;
  },
}));

vi.mock("@/lib/terminal/operations", () => ({
  createTerminalOperations: vi.fn(() => ({
    read: { readFile: vi.fn(), access: vi.fn(), detectImageMimeType: vi.fn() },
    write: { writeFile: vi.fn(), mkdir: vi.fn() },
    edit: { readFile: vi.fn(), writeFile: vi.fn(), access: vi.fn() },
    bash: { exec: vi.fn() },
  })),
}));

vi.mock("@/lib/council/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/council/commands")>();
  return {
    ...actual,
    runTerminalCommand: vi.fn(),
    runContainerCommand: vi.fn(),
  };
});

import { runContainerCommand, runTerminalCommand } from "@/lib/council/commands";
import { sandboxIdentity } from "@/lib/council/accounts";
import { destroyCouncilSandbox, ensureCouncilSandbox } from "@/lib/council/sandbox";

const probe = vi.mocked(runTerminalCommand);
const container = vi.mocked(runContainerCommand);

const IDENTITY = sandboxIdentity("3bd99582");

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.configured = true;
  container.mockResolvedValue({ exitCode: 0, output: "" });
});

describe("ensureCouncilSandbox", () => {
  it("provisions the account as the council's own identity and checks it", async () => {
    probe.mockResolvedValue({ exitCode: 0, output: `${IDENTITY.account}\n` });

    await ensureCouncilSandbox(IDENTITY);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(
      "id -un",
      expect.objectContaining({ userId: "3bd99582", cwd: IDENTITY.home }),
    );
  });

  it("refuses to run when the container did not honour the sandbox identity", async () => {
    // What `OPEN_TERMINAL_MULTI_USER=false` looks like: the command ran as the
    // deployment's own account, i.e. inside the user's workspace.
    probe.mockResolvedValue({ exitCode: 0, output: "user\n" });

    await expect(ensureCouncilSandbox(IDENTITY)).rejects.toThrow(/OPEN_TERMINAL_MULTI_USER=true/);
  });

  it("re-provisions an account the container still has cached but no longer has", async () => {
    // The observed failure: the account was deleted with its council, and Open
    // Terminal's in-memory cache still claims it exists, so every command for the
    // key fails with `sudo: unknown user` — forever, unless something asks under
    // an id that maps to the same account.
    probe
      .mockResolvedValueOnce({ exitCode: 1, output: `sudo: unknown user ${IDENTITY.account}` })
      .mockResolvedValueOnce({ exitCode: 0, output: `${IDENTITY.account}\n` });

    await ensureCouncilSandbox(IDENTITY);

    expect(probe).toHaveBeenCalledTimes(2);
    const retryId = probe.mock.calls[1]![1]?.userId;
    expect(retryId).not.toBe("3bd99582");
    // It must resolve to the *same* account, or the retry would provision a
    // second workspace nobody can reach.
    expect(sandboxIdentity(retryId!).account).toBe(IDENTITY.account);
  });

  it("reports the container's own error when neither id works", async () => {
    probe.mockResolvedValue({ exitCode: 1, output: "container is down" });

    await expect(ensureCouncilSandbox(IDENTITY)).rejects.toThrow(/container is down/);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("refuses to provision without a terminal integration", async () => {
    hoisted.configured = false;
    await expect(ensureCouncilSandbox(IDENTITY)).rejects.toThrow(/OPEN_TERMINAL_API_KEY/);
    expect(probe).not.toHaveBeenCalled();
  });

  it("accepts an account name behind an operator prefix", async () => {
    // OPEN_TERMINAL_USER_PREFIX is prepended to the derived name and is the
    // operator's to choose (`saale_`, `t-`); the guard is about shell safety,
    // not about the default spelling of a name.
    const prefixed = { ...IDENTITY, account: `saale_${IDENTITY.account}` };
    probe.mockResolvedValue({ exitCode: 0, output: `${prefixed.account}\n` });

    await ensureCouncilSandbox(prefixed);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("refuses an account name it would not be safe to run", async () => {
    await expect(
      ensureCouncilSandbox({ key: "abc", account: "bad; rm -rf /", home: "/home/bad" }),
    ).rejects.toThrow(/unsafe account name/);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("destroyCouncilSandbox", () => {
  it("removes the account and its home as the container's own identity", async () => {
    await destroyCouncilSandbox(IDENTITY);

    expect(container).toHaveBeenCalledWith(`sudo userdel -r ${IDENTITY.account} 2>&1`);
  });

  it("wipes the home anyway when the account could not be deleted", async () => {
    // `userdel -r` refuses while a process of that account is still alive (a
    // killed turn), and the workspace must not survive the delete.
    container.mockImplementation(async (command: string) =>
      command.startsWith("sudo userdel")
        ? { exitCode: 8, output: "user is currently used by process 42" }
        : { exitCode: 0, output: "" },
    );

    await destroyCouncilSandbox(IDENTITY);

    const commands = container.mock.calls.map((call) => call[0]);
    // Order matters: the group survives `userdel` only as long as the container's
    // own account is a member of it, so that membership is dropped before the
    // group is — reverse the two and the group would not be deletable.
    expect(commands).toEqual([
      `sudo userdel -r ${IDENTITY.account} 2>&1`,
      `sudo rm -rf /home/${IDENTITY.account} 2>&1`,
      `sudo gpasswd -d user ${IDENTITY.account} 2>&1`,
      `sudo groupdel ${IDENTITY.account} 2>&1`,
    ]);
  });

  it("does nothing when there is no terminal to clean up in", async () => {
    hoisted.configured = false;
    await destroyCouncilSandbox(IDENTITY);
    expect(container).not.toHaveBeenCalled();
  });

  it("refuses an account name it would not be safe to delete", async () => {
    await expect(
      destroyCouncilSandbox({ key: "abc", account: "bad; rm -rf /", home: "/home/bad" }),
    ).rejects.toThrow(/unsafe account name/);
    expect(container).not.toHaveBeenCalled();
  });
});
