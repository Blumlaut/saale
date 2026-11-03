import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUsers: vi.fn(),
  findCouncils: vi.fn(),
  destroySandbox: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: (...args: unknown[]) => mocks.findUsers(...args) },
    council: { findMany: (...args: unknown[]) => mocks.findCouncils(...args) },
  },
}));

// The real teardown deletes a directory on the mounted volume.
vi.mock("@/lib/sandbox/teardown", () => ({
  destroySandbox: (...args: unknown[]) => mocks.destroySandbox(...args),
}));

import { deleteOrphanWorkspace, WorkspaceOwnedError } from "@/lib/admin/workspaces";
import { InvalidSandboxIdentityError, userIdentity } from "@/lib/sandbox/identity";

const USER_ID = "cmvpiak9i00000ro80zbkka6p";
const ORPHAN = "user-9f2c1b7d4e88";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUsers.mockResolvedValue([{ id: USER_ID }]);
  mocks.findCouncils.mockResolvedValue([]);
  mocks.destroySandbox.mockResolvedValue(undefined);
});

describe("deleteOrphanWorkspace", () => {
  it("removes a directory no account claims", async () => {
    await deleteOrphanWorkspace(ORPHAN);

    expect(mocks.destroySandbox).toHaveBeenCalledWith(ORPHAN);
  });

  it("refuses the directory of an account that still exists", async () => {
    // The page that offered the delete can be a minute old.
    await expect(deleteOrphanWorkspace(userIdentity(USER_ID))).rejects.toThrow(WorkspaceOwnedError);
    expect(mocks.destroySandbox).not.toHaveBeenCalled();
  });

  it("refuses a council's workspace too", async () => {
    mocks.findUsers.mockResolvedValue([]);
    mocks.findCouncils.mockResolvedValue([{ sandboxKey: "7f3a91bc" }]);

    await expect(deleteOrphanWorkspace("council-7f3a91bc")).rejects.toThrow(WorkspaceOwnedError);
    expect(mocks.destroySandbox).not.toHaveBeenCalled();
  });

  it("refuses a string that names no workspace at all", async () => {
    await expect(deleteOrphanWorkspace("../../etc")).rejects.toThrow(InvalidSandboxIdentityError);
    expect(mocks.destroySandbox).not.toHaveBeenCalled();
  });
});
