import { describe, it, expect, vi } from "vitest";
import {
  createWatcher,
  DEFAULT_WAKE_PROMPT,
  MAX_COOLDOWN_MINUTES,
  needsScriptApproval,
  normalizeCronExpression,
  WatcherInputError,
} from "@/lib/watchers/manage";
import { hashScript, UNAPPROVED_SCRIPT_HASH } from "@/lib/watchers/grant";

// The create path is decided by the tool set and the consent it earns, so both
// are stated here rather than resolved: `mail_list` never asks, `mail_send` does.
vi.mock("@/lib/db", () => ({
  prisma: {
    scriptWatcher: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
  },
}));

vi.mock("@/lib/watchers/access", () => ({
  loadWatcherToolAccess: vi.fn(async () => ({
    callable: [],
    callableNames: ["mail_list", "mail_send"],
    toolPolicies: null,
  })),
}));

vi.mock("@/lib/queue", () => ({
  scheduleWatcher: vi.fn(async () => {}),
  syncWatcherSchedule: vi.fn(async () => {}),
  unscheduleWatcher: vi.fn(async () => {}),
}));

import { prisma } from "@/lib/db";

/**
 * The watcher write rules. A watcher runs unattended, so what it accepts has to
 * be what the tick can actually act on  a cadence BullMQ cannot parse, or a
 * grant that no longer matches the script it was given for, are the two ways a
 * saved watcher becomes a silent one.
 */

describe("normalizeCronExpression", () => {
  it("accepts a five-field expression and collapses extra whitespace", () => {
    expect(normalizeCronExpression("  */10   * * *  * ")).toBe("*/10 * * * *");
    expect(normalizeCronExpression("0 9 * * 1")).toBe("0 9 * * 1");
    expect(normalizeCronExpression("0,30 8-18 * * MON-FRI")).toBe("0,30 8-18 * * MON-FRI");
  });

  it("rejects a missing or empty cadence", () => {
    expect(() => normalizeCronExpression(undefined)).toThrow(WatcherInputError);
    expect(() => normalizeCronExpression("   ")).toThrow(WatcherInputError);
  });

  it("rejects the field counts a watcher cannot be scheduled with", () => {
    // BullMQ takes five fields; a six-field (seconds) expression would be
    // scheduled as something else entirely, and a four-field one never fires.
    expect(() => normalizeCronExpression("*/10 * * * * *")).toThrow(/5-field/);
    expect(() => normalizeCronExpression("*/10 * * *")).toThrow(/5-field/);
    expect(() => normalizeCronExpression("every ten minutes")).toThrow(/5-field/);
  });

  it("rejects characters cron does not use", () => {
    expect(() => normalizeCronExpression("*/10 * * * *; rm -rf /")).toThrow(WatcherInputError);
    expect(() => normalizeCronExpression("*/10 * * * $(date)")).toThrow(WatcherInputError);
  });

  it("reports the offending expression so the user can fix it", () => {
    expect(() => normalizeCronExpression("nope nope nope nope nope")).toThrow(
      /nope nope nope nope nope/,
    );
  });
});

describe("needsScriptApproval", () => {
  const script = "return await tools.mail_list({});";

  it("holds while the script matches the hash it was approved at", () => {
    expect(needsScriptApproval({ script, scriptHash: hashScript(script) })).toBe(false);
  });

  it("is true when the script changed under its approval", () => {
    expect(
      needsScriptApproval({ script: `${script}\n// edited`, scriptHash: hashScript(script) }),
    ).toBe(true);
  });

  it("notices a change that differs only in whitespace", () => {
    // A rewrite is a rewrite: the hash is over the exact source the user read.
    expect(needsScriptApproval({ script: `${script} `, scriptHash: hashScript(script) })).toBe(
      true,
    );
  });
});

describe("the limits a watcher is created with", () => {
  it("bounds the cooldown at a week", () => {
    expect(MAX_COOLDOWN_MINUTES).toBe(10_080);
  });

  it("has a wake prompt that tells the agent to act and report", () => {
    expect(DEFAULT_WAKE_PROMPT).toMatch(/act on it/i);
    expect(DEFAULT_WAKE_PROMPT).toMatch(/tell me/i);
  });
});

describe("createWatcher and who approved the script", () => {
  it("ticks a script that needs no consent, whoever wrote it", async () => {
    const created = await createWatcher({
      userId: "user-1",
      approvedByUser: false,
      fields: {
        name: "Watch the inbox",
        script: "return await tools.mail_list({ folder: 'inbox' });",
        cronExpression: "*/10 * * * *",
      },
    });

    // `mail_list` is `allow`, so there is nothing for a person to approve and
    // the watcher is live from the moment it exists.
    expect(created.needsApproval).toBe(false);
    expect(created.grantedTools).toEqual([]);
  });

  it("pauses a script the model wrote that would call a tool needing approval", async () => {
    const created = await createWatcher({
      userId: "user-1",
      approvedByUser: false,
      fields: {
        name: "Forward the important mail",
        script: "return await tools.mail_send({ to: 'me@example.com' });",
        cronExpression: "*/10 * * * *",
      },
    });

    expect(created.needsApproval).toBe(true);
    expect(created.grantedTools).toEqual(["mail_send"]);
    // The stored hash cannot describe the script, which is what "unapproved"
    // means everywhere the row is read: the UI offers the approval and the tick
    // is refused until it is given.
    const written = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(written?.scriptHash).toBe(UNAPPROVED_SCRIPT_HASH);
    expect(
      needsScriptApproval({
        script: String(written?.script),
        scriptHash: String(written?.scriptHash),
      }),
    ).toBe(true);
  });

  it("starts the same script immediately when the user is the one saving it", async () => {
    const created = await createWatcher({
      userId: "user-1",
      approvedByUser: true,
      fields: {
        name: "Forward the important mail",
        script: "return await tools.mail_send({ to: 'me@example.com' });",
        cronExpression: "*/10 * * * *",
      },
    });

    expect(created.needsApproval).toBe(false);
    const written = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(written?.scriptHash).toBe(hashScript(String(written?.script)));
  });
});
