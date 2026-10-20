import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createContact, listContacts, contactCreateSchema } from "@/lib/contacts/contacts";

/**
 * GET /api/contacts. List contacts with optional search
 * Query params: search, limit
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "200", 10), 500);

  try {
    const contacts = await listContacts(authResult.user.id, {
      ...(search ? { search } : {}),
      limit,
    });
    return NextResponse.json({ contacts });
  } catch (err) {
    console.error("Failed to list contacts:", err);
    return NextResponse.json({ error: "Failed to list contacts" }, { status: 500 });
  }
}

/**
 * POST /api/contacts. Create a contact. 409 when the email already exists.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const parsed = contactCreateSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const contact = await createContact(authResult.user.id, parsed.data);
    if (!contact) {
      return NextResponse.json(
        { error: "A contact with this email already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    console.error("Failed to create contact:", err);
    return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
  }
}
