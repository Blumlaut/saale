import { requireAdminSection } from "@/lib/permissions/guards";

export default async function AdminSectionLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSection("models");
  return children;
}
