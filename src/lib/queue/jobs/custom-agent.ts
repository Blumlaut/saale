import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/lib/agent-jobs/executor";

export const metadata = {
  type: "custom-agent",
  label: "Custom Agent",
  description: "Run a custom AI agent with your own prompt and tool selection",
  icon: "Brain",
  defaultCron: "0 9 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "prompt",
    label: "Prompt",
    description: "The task prompt sent to the agent each run",
    type: "text" as const,
  },
  {
    key: "systemPrompt",
    label: "System Prompt",
    description: "Optional system prompt for the agent",
    type: "text" as const,
  },
  {
    key: "modelId",
    label: "Model",
    description: "AI model to use for this job",
    type: "model" as const,
  },
  {
    key: "toolConfig",
    label: "Tools",
    description: "Which tool categories to expose to the agent",
    type: "multiSelect" as const,
    default: "email,jobs,calendar,web,memory,tasks",
    options: [
      { value: "email", label: "Email" },
      { value: "jobs", label: "Jobs" },
      { value: "calendar", label: "Calendar" },
      { value: "web", label: "Web" },
      { value: "memory", label: "Memory" },
      { value: "tasks", label: "Tasks" },
      { value: "chatSearch", label: "Chat Search" },
      { value: "terminal", label: "Terminal" },
    ] as Array<{ value: string; label: string }>,
  },
] as const;

export const handler = async ({
  config,
  userId,
}: {
  config: Record<string, unknown>;
  userId: string;
}) => {
  const prompt = config.prompt as string;
  if (!prompt) {
    throw new Error("Prompt is required for custom agent jobs");
  }

  const systemPrompt = (config.systemPrompt as string) || null;
  const modelId = (config.modelId as string) || null;

  // Parse toolConfig from comma-separated string or object
  let toolConfig: Prisma.InputJsonValue | null = null;
  const rawToolConfig = config.toolConfig;
  if (typeof rawToolConfig === "string" && rawToolConfig.length > 0) {
    toolConfig = Object.fromEntries(rawToolConfig.split(",").map((t) => [t.trim(), true]));
  } else if (typeof rawToolConfig === "object" && rawToolConfig !== null) {
    toolConfig = rawToolConfig;
  }

  // Find or create an AgentDefinition for this queue task
  const definition = await prisma.agentDefinition.upsert({
    where: {
      userId_name: {
        userId,
        name: "Custom Agent (job)",
      },
    },
    create: {
      userId,
      name: "Custom Agent (job)",
      prompt,
      systemPrompt: (systemPrompt ?? Prisma.DbNull) as unknown as string | null,
      toolConfig: (toolConfig ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
      modelId: (modelId ?? Prisma.DbNull) as unknown as string | null,
      enabled: true,
    },
    update: {
      prompt,
      systemPrompt: (systemPrompt ?? Prisma.DbNull) as unknown as string | null,
      toolConfig: (toolConfig ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
      modelId: (modelId ?? Prisma.DbNull) as unknown as string | null,
    },
  });

  // Create an AgentRun and execute it
  const run = await prisma.agentRun.create({
    data: {
      definitionId: definition.id,
      userId,
      status: "pending",
      prompt,
      systemPrompt: (systemPrompt ?? Prisma.DbNull) as unknown as string | null,
      modelId: (modelId ?? Prisma.DbNull) as unknown as string | null,
    },
  });

  const stats = await executeAgentRun(run.id, { prompt }, userId);

  return JSON.stringify({
    definitionId: definition.id,
    runId: run.id,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cost: stats.cost,
  });
};
