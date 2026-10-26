import { describe, it, expect, vi } from "vitest";
import {
  createWatcher,
  DEFAULT_WAKE_PROMPT,
  MAX_COOLDOWN_MINUTES,
  normalizeCronExpression,
  updateWatcher,
  WatcherInputError,
} from "@/lib/watchers/manage";
import { deliveryNote } from "@/lib/watchers/delivery";

vi.mock("@/lib/db", () => ({
  prisma: {
    scriptWatcher: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    chatSession: { findFirst: vi.fn(async () => ({ id: "chat-1" })) },
    coderProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
  },
}));

vi.mock("@/lib/queue", () => ({
  scheduleWatcher: vi.fn(async () => {}),
  syncWatcherSchedule: vi.fn(async () => {}),
  unscheduleWatcher: vi.fn(async () => {}),
}));

import { prisma } from "@/lib/db";

/**
 * The watcher write rules. A watcher runs unattended, so what it accepts has to
 * be what the tick can actually act on. A cadence BullMQ cannot parse is the way
 * a saved watcher becomes a silent one.
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

describe("the limits a watcher is created with", () => {
  it("bounds the cooldown at a week", () => {
    expect(MAX_COOLDOWN_MINUTES).toBe(10_080);
  });

  it("has a wake prompt that tells the agent to act and report", () => {
    expect(DEFAULT_WAKE_PROMPT).toMatch(/act on it/i);
    expect(DEFAULT_WAKE_PROMPT).toMatch(/tell me/i);
  });
});

describe("createWatcher", () => {
  it("saves a script that calls a tool which would ask in a chat", async () => {
    const created = await createWatcher({
      userId: "user-1",
      fields: {
        name: "Forward the important mail",
        script: "return await tools.mail_send({ to: 'me@example.com' });",
        cronExpression: "*/10 * * * *",
        deliver: "silent",
      },
    });

    const written = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(created.name).toBe("Forward the important mail");
    expect(written?.script).toContain("mail_send");
  });

  it("refuses a second watcher with a name the user already has", async () => {
    vi.mocked(prisma.scriptWatcher.findFirst).mockResolvedValueOnce({ id: "w-9" } as never);

    await expect(
      createWatcher({
        userId: "user-1",
        fields: {
          name: "Watch the inbox",
          script: "return 1;",
          cronExpression: "*/10 * * * *",
          deliver: "silent",
        },
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("where a fire is delivered", () => {
  const script = "return await tools.mail_list({});";
  const cronExpression = "*/10 * * * *";

  it("refuses a conversation delivery without a conversation", async () => {
    await expect(
      createWatcher({
        userId: "user-1",
        fields: { name: "No target", script, cronExpression, deliver: "chat" },
      }),
    ).rejects.toThrow(/needs one/);
  });

  it("refuses a coder delivery without a project", async () => {
    await expect(
      createWatcher({
        userId: "user-1",
        fields: { name: "No project", script, cronExpression, deliver: "coder" },
      }),
    ).rejects.toThrow(/needs one/);
  });

  it("refuses a target that is not the user's own", async () => {
    vi.mocked(prisma.coderProject.findFirst).mockResolvedValueOnce(null);

    await expect(
      createWatcher({
        userId: "user-1",
        fields: {
          name: "Someone else's repo",
          script,
          cronExpression,
          deliver: "coder",
          projectId: "project-1",
        },
      }),
    ).rejects.toThrow(/Project not found/);
  });

  it("stores a coder target with its worktree mode and retention", async () => {
    await createWatcher({
      userId: "user-1",
      fields: {
        name: "Review pull requests",
        script,
        cronExpression,
        deliver: "coder",
        projectId: "project-1",
        worktreeMode: "sticky",
        retentionMinutes: 60,
      },
    });

    const written = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(written?.deliver).toBe("coder");
    expect(written?.projectId).toBe("project-1");
    expect(written?.worktreeMode).toBe("sticky");
    expect(written?.retentionMinutes).toBe(60);
  });

  it("keeps the chat a fire reports into, and no other", async () => {
    await createWatcher({
      userId: "user-1",
      fields: {
        name: "Review pull requests",
        script,
        cronExpression,
        deliver: "coder",
        projectId: "project-1",
        sessionId: "chat-1",
      },
    });

    // The chat it was created from is not a target, so deleting that chat must
    // not delete a watcher that never reported into it.
    const writtenCoder = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(writtenCoder?.sessionId).toBeNull();

    await createWatcher({
      userId: "user-1",
      fields: {
        name: "Watch the inbox",
        script,
        cronExpression,
        deliver: "chat",
        sessionId: "chat-1",
      },
    });

    const writtenChat = vi.mocked(prisma.scriptWatcher.create).mock.calls.at(-1)?.[0]?.data;
    expect(writtenChat?.sessionId).toBe("chat-1");
  });

  it("clears the project when the delivery moves away from a project", async () => {
    vi.mocked(prisma.scriptWatcher.findFirst).mockResolvedValueOnce({
      id: "w-1",
      userId: "user-1",
      name: "Review pull requests",
      description: null,
      script,
      cronExpression,
      enabled: true,
      deliver: "coder",
      sessionId: "chat-1",
      projectId: "project-1",
      worktreeMode: "sticky",
      retentionMinutes: 60,
      stickySessionId: null,
      wakePrompt: "Act.",
      modelId: null,
      store: {},
      lastValue: null,
      lastTickAt: null,
      lastError: null,
      lastFiredAt: null,
      tickCount: 0,
      fireCount: 0,
      cooldownMinutes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    await updateWatcher({
      id: "w-1",
      userId: "user-1",
      fields: { deliver: "silent" },
    });

    const written = vi.mocked(prisma.scriptWatcher.update).mock.calls.at(-1)?.[0]?.data;
    expect(written?.deliver).toBe("silent");
    expect(written?.projectId).toBeNull();
    // Moving off a chat fire drops the chat it used to answer in.
    expect(written?.sessionId).toBeNull();
  });

  it("keeps the default model when an update does not name one", async () => {
    vi.mocked(prisma.scriptWatcher.findFirst).mockResolvedValueOnce({
      id: "w-1",
      userId: "user-1",
      name: "Review pull requests",
      description: null,
      script,
      cronExpression,
      enabled: true,
      deliver: "coder",
      sessionId: null,
      projectId: "project-1",
      worktreeMode: "per-fire",
      retentionMinutes: 1440,
      stickySessionId: null,
      wakePrompt: "Act.",
      modelId: "anthropic:claude-sonnet-4",
      store: {},
      lastValue: null,
      lastTickAt: null,
      lastError: null,
      lastFiredAt: null,
      tickCount: 0,
      fireCount: 0,
      cooldownMinutes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    await updateWatcher({
      id: "w-1",
      userId: "user-1",
      fields: { modelId: null },
    });

    const written = vi.mocked(prisma.scriptWatcher.update).mock.calls.at(-1)?.[0]?.data;
    expect(written?.modelId).toBeNull();
  });
});

describe("deliveryNote", () => {
  it("says where each target puts a fire", () => {
    expect(deliveryNote("chat")).toMatch(/posted into its conversation/);
    expect(deliveryNote("coder")).toMatch(/coder chat in its project/);
    expect(deliveryNote("silent")).toMatch(/wakes nobody/);
  });

  it("never promises a wake the target does not do", () => {
    for (const target of ["chat", "coder", "silent"] as const) {
      expect(deliveryNote(target).length).toBeGreaterThan(0);
    }
    expect(deliveryNote("silent")).not.toMatch(/answers you|wakes you/);
  });
});
