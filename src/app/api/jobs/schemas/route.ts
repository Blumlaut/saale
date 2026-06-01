import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";
import { buildModelRegistry } from "@/lib/pi/models";

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
  const { models, modelRegistry } = await buildModelRegistry(session.user.id);

  const modelOptions = [
    { value: "", label: "Auto (use default)" },
    ...models.map((m) => ({
      value: `${m.provider}:${m.id}`,
      label: `${m.name} (${modelRegistry.getProviderDisplayName(m.provider)})`,
    })),
  ];

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
