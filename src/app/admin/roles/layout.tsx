import { requireAdminSection } from "@/lib/permissions/guards";

export default async function AdminRolesLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSection("roles");
  return children;
}
