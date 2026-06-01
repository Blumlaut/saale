import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * GET /api/jobs/schemas — Return job type schemas with runtime data.
 * Populates select field options (e.g. email accounts, models) from the database.
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch email accounts for select fields
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: session.user.id, enabled: true },
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });

  const accountOptions = [
    { value: "", label: "All accounts" },
    ...accounts.map((a) => ({ value: a.id, label: a.email })),
  ];

  // Fetch available models for AI job types
  const modelOptions = await getModelOptions(session.user.id);

  // Deep clone schemas and populate runtime options
  const schemas = jobTypeSchemas.map((schema) => {
    const fields = schema.fields.map((field) => {
      if (field.key === "accountId" && field.type === "select") {
        return { ...field, options: accountOptions };
      }
      if (field.key === "modelId" && field.type === "select") {
        return { ...field, options: modelOptions };
      }
      return field;
    });

    return { ...schema, fields };
  });

  return NextResponse.json({ schemas });
}

async function getModelOptions(userId: string) {
  const options = [{ value: "", label: "Auto (use default)" }];

  try {
    // Load user's provider API keys
    const storedKeys = await prisma.providerApiKey.findMany({
      where: { userId },
      select: { provider: true, encryptedKey: true, baseUrl: true },
    });

    const authStorage = AuthStorage.inMemory();
    for (const key of storedKeys) {
      try {
        const decryptedKey = decrypt(key.encryptedKey);
        if (decryptedKey) {
          authStorage.setRuntimeApiKey(key.provider, decryptedKey);
        }
      } catch {
        // skip
      }
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Register custom providers
    for (const key of storedKeys) {
      if (key.provider === "custom" && key.baseUrl) {
        const decryptedKey = decrypt(key.encryptedKey);
        const baseUrl = key.baseUrl.replace(/\/+$/, "");
        try {
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
          });
        } catch {
          // skip
        }
      }
    }

    // Get available models
    const available = modelRegistry.getAvailable();
    for (const model of available) {
      options.push({
        value: `${model.provider}:${model.id}`,
        label: `${model.name} (${modelRegistry.getProviderDisplayName(model.provider)})`,
      });
    }
  } catch {
    // If model discovery fails, just return the "Auto" option
  }

  return options;
}
