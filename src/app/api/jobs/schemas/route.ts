import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";

/**
 * GET /api/jobs/schemas. Return job type schemas with runtime data.
 * Populates select field options (e.g. email accounts) from the database.
 * Model fields use the shared ModelPicker component (no options needed here).
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Fetch email accounts for select fields
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: authResult.user.id, enabled: true },
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });

  const accountOptions = [
    { value: "", label: "All accounts" },
    ...accounts.map((a) => ({ value: a.id, label: a.email })),
  ];

  // Deep clone schemas and populate runtime options
  const schemas = jobTypeSchemas.map((schema) => {
    const fields = schema.fields.map((field) => {
      if (field.key === "accountId" && field.type === "select") {
        return { ...field, options: accountOptions };
      }
      return field;
    });

    return { ...schema, fields };
  });

  return NextResponse.json({ schemas });
}
