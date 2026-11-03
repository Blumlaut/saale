import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteOrphanWorkspace, WorkspaceOwnedError } from "@/lib/admin/workspaces";
import { InvalidSandboxIdentityError } from "@/lib/sandbox/identity";

/** Delete a directory no account owns, taking its container with it. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ identity: string }> },
) {
  const access = await requirePermission("admin", "workspaces");
  if (!access.ok) return access.response;

  const { identity } = await params;
  try {
    await deleteOrphanWorkspace(identity);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof WorkspaceOwnedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidSandboxIdentityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`Failed to delete the workspace ${identity}:`, err);
    return NextResponse.json({ error: "The directory could not be removed" }, { status: 500 });
  }
}
