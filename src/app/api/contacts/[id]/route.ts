import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getContact,
  updateContact,
  deleteContact,
  contactUpdateSchema,
} from "@/lib/contacts/contacts";

/**
 * GET /api/contacts/[id]. Get a single contact
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const contact = await getContact(authResult.user.id, id);
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ contact });
}

/**
 * PATCH /api/contacts/[id]. Update a contact
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const parsed = contactUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const contact = await updateContact(authResult.user.id, id, parsed.data);
    return NextResponse.json({ contact });
  } catch (err) {
    if (err instanceof Error && err.message === "Contact not found") {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    console.error("Failed to update contact:", err);
    return NextResponse.json({ error: "Failed to update contact" }, { status: 500 });
  }
}

/**
 * DELETE /api/contacts/[id]. Delete a contact
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const deleted = await deleteContact(authResult.user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
