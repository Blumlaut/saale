import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockRedis } from "../../helpers/in-memory-redis";
import {
  clearProvisioning,
  getProvisioning,
  parseProvisioning,
  setProvisioningStep,
} from "@/lib/coder/provisioning";

/**
 * The record a chat reads to know its workspace is still being built.
 *
 * It is written by whichever process runs the build and read by every open tab,
 * so it has to survive a round trip through JSON and never hand a caller a step
 * it cannot name. a hint is only worth having if it is true.
 */

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

describe("parseProvisioning", () => {
  it("reads back a record it wrote", () => {
    const startedAt = new Date().toISOString();
    expect(parseProvisioning(JSON.stringify({ step: "setup", startedAt }))).toEqual({
      step: "setup",
      startedAt,
    });
  });

  it("treats anything unusable as no record at all", () => {
    expect(parseProvisioning(null)).toBeNull();
    expect(parseProvisioning("")).toBeNull();
    expect(parseProvisioning("not json")).toBeNull();
    expect(parseProvisioning("[]")).toBeNull();
    // A step this version does not know: an old record, not a hint.
    expect(
      parseProvisioning(JSON.stringify({ step: "cloning", startedAt: new Date().toISOString() })),
    ).toBeNull();
    // A timestamp the client cannot measure elapsed time from.
    expect(parseProvisioning(JSON.stringify({ step: "worktree", startedAt: "soon" }))).toBeNull();
    expect(parseProvisioning(JSON.stringify({ step: "worktree" }))).toBeNull();
  });
});

describe("the provisioning record", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  it("is absent until a build starts", async () => {
    expect(await getProvisioning("session-1")).toBeNull();
  });

  it("moves through the steps and can be cleared", async () => {
    await setProvisioningStep("session-1", "worktree");
    expect((await getProvisioning("session-1"))?.step).toBe("worktree");

    await setProvisioningStep("session-1", "setup");
    const setup = await getProvisioning("session-1");
    expect(setup?.step).toBe("setup");
    expect(Number.isNaN(Date.parse(setup!.startedAt))).toBe(false);

    await clearProvisioning("session-1");
    expect(await getProvisioning("session-1")).toBeNull();
  });

  it("keeps one chat's build out of another's", async () => {
    await setProvisioningStep("session-1", "setup");
    expect(await getProvisioning("session-2")).toBeNull();

    await clearProvisioning("session-2");
    expect((await getProvisioning("session-1"))?.step).toBe("setup");
  });

  it("expires on its own, so a crashed build cannot leave a stuck hint", async () => {
    await setProvisioningStep("session-1", "setup");
    const { getRedis } = await import("@/lib/redis");
    const ttl = await getRedis().ttl("coder:provisioning:session-1");
    // Longer than a setup script may run, shorter than forever.
    expect(ttl).toBeGreaterThan(900);
    expect(ttl).toBeLessThanOrEqual(1800);
  });
});
