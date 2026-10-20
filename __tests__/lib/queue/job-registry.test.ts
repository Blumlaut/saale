import { describe, it, expect } from "vitest";
import { handlers, handlerMap, jobTypeSchemas } from "@/lib/queue/jobs/registry";
import { getJobSchema } from "@/lib/queue/job-schemas";

describe("job handlers registry", () => {
  it("has 12 registered handlers", () => {
    expect(handlers).toHaveLength(12);
  });

  it("each handler has required exports", () => {
    for (const handler of handlers) {
      expect(handler.metadata).toBeDefined();
      expect(handler.metadata.type).toBeTypeOf("string");
      expect(handler.metadata.type).not.toBe("");
      expect(handler.metadata.label).toBeTypeOf("string");
      expect(handler.metadata.description).toBeTypeOf("string");
      expect(handler.metadata.icon).toBeTypeOf("string");
      expect(handler.metadata.defaultCron).toBeTypeOf("string");
      expect(typeof handler.metadata.usesAi).toBe("boolean");
      expect(Array.isArray(handler.fields)).toBe(true);
      expect(typeof handler.handler).toBe("function");
    }
  });

  it("has unique handler types", () => {
    const types = handlers.map((h) => h.metadata.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  it("has expected handler types", () => {
    const types = handlers.map((h) => h.metadata.type);
    expect(types).toContain("email_sync");
    expect(types).toContain("summarization");
    expect(types).toContain("classification");
    expect(types).toContain("spam_filtering");
    expect(types).toContain("calendar_sync");
    expect(types).toContain("email_to_calendar");
    expect(types).toContain("subscription_sync");
    expect(types).toContain("memory_extraction");
    expect(types).toContain("memory_pruning");
    expect(types).toContain("chat_title_generation");
  });

  it("each handler has a valid cron expression", () => {
    for (const handler of handlers) {
      const cron = handler.metadata.defaultCron;
      // Basic cron validation: 5 space-separated fields
      const parts = cron.split(" ");
      expect(parts.length).toBe(5);
    }
  });
});

describe("handlerMap", () => {
  it("maps every handler type to its module", () => {
    for (const handler of handlers) {
      const found = handlerMap.get(handler.metadata.type);
      expect(found).toBe(handler);
    }
  });

  it("returns undefined for unknown types", () => {
    expect(handlerMap.get("nonexistent")).toBeUndefined();
    expect(handlerMap.get("")).toBeUndefined();
  });

  it("has 12 entries", () => {
    expect(handlerMap.size).toBe(12);
  });
});

describe("jobTypeSchemas", () => {
  it("has one schema per handler", () => {
    expect(jobTypeSchemas).toHaveLength(handlers.length);
  });

  it("each schema has required fields", () => {
    for (const schema of jobTypeSchemas) {
      expect(schema.type).toBeTypeOf("string");
      expect(schema.label).toBeTypeOf("string");
      expect(schema.description).toBeTypeOf("string");
      expect(schema.icon).toBeTypeOf("string");
      expect(schema.defaultCron).toBeTypeOf("string");
      expect(Array.isArray(schema.fields)).toBe(true);
    }
  });

  it("derives schemas from handler metadata", () => {
    for (const handler of handlers) {
      const schema = jobTypeSchemas.find((s) => s.type === handler.metadata.type);
      expect(schema).toBeDefined();
      expect(schema!.label).toBe(handler.metadata.label);
      expect(schema!.description).toBe(handler.metadata.description);
      expect(schema!.icon).toBe(handler.metadata.icon);
      expect(schema!.defaultCron).toBe(handler.metadata.defaultCron);
      expect(schema!.usesAi).toBe(handler.metadata.usesAi);
      expect(schema!.fields).toStrictEqual(handler.fields);
    }
  });

  it("has unique schema types", () => {
    const types = jobTypeSchemas.map((s) => s.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  it("AI jobs have usesAi true", () => {
    const aiJobs = jobTypeSchemas.filter((s) => s.usesAi);
    expect(aiJobs.map((s) => s.type)).toContain("summarization");
    expect(aiJobs.map((s) => s.type)).toContain("classification");
    expect(aiJobs.map((s) => s.type)).toContain("memory_extraction");
    expect(aiJobs.map((s) => s.type)).toContain("chat_title_generation");
    expect(aiJobs.map((s) => s.type)).toContain("spam_filtering");
    expect(aiJobs.map((s) => s.type)).toContain("email_to_calendar");
  });

  it("non-AI jobs have usesAi false", () => {
    const nonAiJobs = jobTypeSchemas.filter((s) => !s.usesAi);
    expect(nonAiJobs.map((s) => s.type)).toContain("email_sync");
    expect(nonAiJobs.map((s) => s.type)).toContain("calendar_sync");
    expect(nonAiJobs.map((s) => s.type)).toContain("subscription_sync");
  });

  it("spam_filtering uses AI", () => {
    const schema = getJobSchema("spam_filtering");
    expect(schema!.usesAi).toBe(true);
  });
});

describe("getJobSchema", () => {
  it("returns schema for valid types", () => {
    const schema = getJobSchema("email_sync");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("email_sync");
    expect(schema!.label).toBe("Email Sync");
  });

  it("returns undefined for invalid types", () => {
    expect(getJobSchema("nonexistent")).toBeUndefined();
    expect(getJobSchema("")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(getJobSchema("email_sync")).toBeDefined();
    expect(getJobSchema("Email_Sync")).toBeUndefined();
    expect(getJobSchema("EMAIL_SYNC")).toBeUndefined();
  });
});

describe("job field definitions", () => {
  it("email_sync has accountId field", () => {
    const schema = getJobSchema("email_sync");
    expect(schema).toBeDefined();
    expect(schema!.fields).toHaveLength(1);
    expect(schema!.fields[0]).toMatchObject({
      key: "accountId",
      type: "select",
    });
  });

  it("summarization has accountId, limit, maxEmailAge, and modelId fields", () => {
    const schema = getJobSchema("summarization");
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain("accountId");
    expect(keys).toContain("limit");
    expect(keys).toContain("maxEmailAge");
    expect(keys).toContain("modelId");
  });

  it("number fields have min/max/step constraints", () => {
    const schema = getJobSchema("summarization");
    const limitField = schema!.fields.find((f) => f.key === "limit");
    expect(limitField).toMatchObject({
      type: "number",
      min: 1,
      max: 100,
      step: 1,
    });
  });

  it("modelId fields have type 'model'", () => {
    const schema = getJobSchema("summarization");
    const modelField = schema!.fields.find((f) => f.key === "modelId");
    expect(modelField).toMatchObject({
      type: "model",
    });
  });

  it("chat_title_generation has maxSessionsPerRun field", () => {
    const schema = getJobSchema("chat_title_generation");
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain("maxSessionsPerRun");
    expect(keys).toContain("modelId");
  });

  it("spam_filtering has spamThreshold field", () => {
    const schema = getJobSchema("spam_filtering");
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain("spamThreshold");
  });

  it("email_to_calendar has targetCalendarId and modelId fields", () => {
    const schema = getJobSchema("email_to_calendar");
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain("accountId");
    expect(keys).toContain("targetCalendarId");
    expect(keys).toContain("limit");
    expect(keys).toContain("maxEmailAge");
    expect(keys).toContain("modelId");
  });

  it("memory_pruning has an unusedDays field", () => {
    const schema = getJobSchema("memory_pruning");
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain("unusedDays");
  });

  it("memory_pruning fields have min/max constraints", () => {
    const schema = getJobSchema("memory_pruning");
    const unusedDays = schema!.fields.find((f) => f.key === "unusedDays");
    expect(unusedDays).toMatchObject({
      type: "number",
      min: 30,
      max: 365,
    });
  });

  it("subscription_sync has no custom fields", () => {
    const schema = getJobSchema("subscription_sync");
    expect(schema).toBeDefined();
    expect(schema!.fields).toHaveLength(0);
  });
});
