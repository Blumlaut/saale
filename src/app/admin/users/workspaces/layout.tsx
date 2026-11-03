import { requireAdminSection } from "@/lib/permissions/guards";

export default async function AdminWorkspacesLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSection("workspaces");
  return children;
}
