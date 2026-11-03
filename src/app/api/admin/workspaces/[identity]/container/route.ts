import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { removeWorkspaceContainer } from "@/lib/admin/workspaces";
import { isConfigured } from "@/lib/sandbox/client";
import { InvalidSandboxIdentityError } from "@/lib/sandbox/identity";

/** Remove a workspace's container. The directory and its files stay. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ identity: string }> },
) {
  const access = await requirePermission("admin", "workspaces");
  if (!access.ok) return access.response;

  if (!isConfigured()) {
    return NextResponse.json({ error: "This deployment runs no sandbox service" }, { status: 503 });
  }

  const { identity } = await params;
  try {
    await removeWorkspaceContainer(identity);
    return NextResponse.json({ removed: true });
  } catch (err) {
    if (err instanceof InvalidSandboxIdentityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`Failed to remove the container of ${identity}:`, err);
    return NextResponse.json({ error: "The container could not be removed" }, { status: 500 });
  }
}
