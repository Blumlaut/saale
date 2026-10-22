import { requireAdminSection } from "@/lib/permissions/guards";

export default async function AdminPluginsLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSection("plugins");
  return children;
}
