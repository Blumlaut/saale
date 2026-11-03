import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The three email-batch jobs (classification, summarization, spam filtering)
 * share this path. What matters to all of them is that a result the model
 * invents never reaches a row, since it writes by id.
 */

const { findMany, update, mockDispatch, mockResolveAccounts } = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  mockDispatch: vi.fn(),
  mockResolveAccounts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { emailMessage: { findMany, update } },
}));

vi.mock("@/lib/queue/job-handler", () => ({ dispatchAiJob: mockDispatch }));
vi.mock("@/lib/queue/user-isolation", () => ({
  resolveUserEmailAccountIds: mockResolveAccounts,
}));

import { runEmailAiJob } from "@/lib/queue/jobs/email-ai";

const ROWS = [
  {
    id: "email-1",
    subject: "Invoice",
    fromEmail: "billing@example.com",
    bodyPreview: "Your invoice",
    bodyText: null,
  },
  {
    id: "email-2",
    subject: "Lunch",
    fromEmail: "friend@example.com",
    bodyPreview: "Lunch?",
    bodyText: "Lunch tomorrow?",
  },
];

function run(overrides: Partial<Parameters<typeof runEmailAiJob>[0]> = {}) {
  return runEmailAiJob<(typeof ROWS)[number], { id: string; summary: string }>({
    userId: "user-1",
    config: {},
    context: "test/email-ai",
    where: { aiSummary: null },
    select: { id: true, subject: true, fromEmail: true, bodyPreview: true, bodyText: true },
    defaultLimit: 10,
    task: "summarize",
    instructions: "Summarize each email.",
    resultKey: "summaries",
    accept: (entry) => Boolean(entry.id) && typeof entry.summary === "string",
    apply: async (row, entry) => {
      update({ where: { id: row.id }, data: { aiSummary: entry.summary } });
    },
    ...overrides,
  });
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue(ROWS);
  update.mockReset();
  mockDispatch.mockReset();
  mockResolveAccounts.mockReset().mockResolvedValue(["account-1"]);
});

describe("runEmailAiJob", () => {
  it("writes the accepted results and reports what it did", async () => {
    mockDispatch.mockResolvedValue(
      '```json\n{ "summaries": [{ "id": "email-1", "summary": "A bill" }, { "id": "email-2", "summary": "Lunch plans" }] }\n```',
    );

    const result = await run();

    expect(result.batch).toHaveLength(2);
    expect(result.applied).toBe(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: "email-1" },
      data: { aiSummary: "A bill" },
    });

    const prompt = JSON.parse(mockDispatch.mock.calls[0][1] as string);
    expect(prompt.task).toBe("summarize");
    expect(prompt.emails).toEqual([
      { id: "email-1", from: "billing@example.com", subject: "Invoice", preview: "Your invoice" },
      { id: "email-2", from: "friend@example.com", subject: "Lunch", preview: "Lunch tomorrow?" },
    ]);
  });

  it("ignores a result whose id is not in the batch", async () => {
    mockDispatch.mockResolvedValue(
      JSON.stringify({
        summaries: [
          { id: "email-1", summary: "A bill" },
          { id: "someone-elses-email", summary: "Not ours" },
        ],
      }),
    );

    const result = await run();

    expect(result.applied).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "email-1" },
      data: { aiSummary: "A bill" },
    });
  });

  it("drops entries that do not carry what the job needs", async () => {
    mockDispatch.mockResolvedValue(
      JSON.stringify({ summaries: [{ id: "email-1" }, { summary: "no id" }] }),
    );

    const result = await run();

    expect(result.applied).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves the batch alone when the answer is not JSON", async () => {
    mockDispatch.mockResolvedValue("I could not summarize these emails.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run();

    expect(result.results).toEqual([]);
    expect(result.applied).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[test/email-ai]"),
      expect.anything(),
    );
    logged.mockRestore();
  });

  it("scopes the query to the owner's accounts and the age window", async () => {
    mockDispatch.mockResolvedValue(JSON.stringify({ summaries: [] }));

    await run({ config: { accountId: "account-1", limit: 5, maxEmailAge: 24 } });

    const query = findMany.mock.calls[0][0];
    expect(query.take).toBe(5);
    expect(query.where.accountId).toBe("account-1");
    expect(query.where.aiSummary).toBeNull();
    const since = (query.where.date as { gte: Date }).gte;
    expect(Date.now() - since.getTime()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("skips the model when the batch is empty", async () => {
    findMany.mockResolvedValue([]);

    const result = await run();

    expect(result).toEqual({ batch: [], accountIds: ["account-1"], results: [], applied: 0 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
