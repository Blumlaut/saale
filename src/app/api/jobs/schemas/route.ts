import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";

/**
 * GET /api/jobs/schemas — Return job type schemas with runtime data.
 * Populates select field options (e.g. email accounts) from the database.
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

  // Deep clone schemas and populate runtime options
  const schemas = jobTypeSchemas.map((schema) => ({
    ...schema,
    fields: schema.fields.map((field) => {
      if (field.key === "accountId" && field.type === "select") {
        return { ...field, options: accountOptions };
      }
      return field;
    })),
  }));

  return NextResponse.json({ schemas });
}
