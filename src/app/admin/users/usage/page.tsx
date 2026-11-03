import { requireAdminSection } from "@/lib/permissions/guards";
import { UsageArea } from "@/components/admin/usage-area";

export default async function AdminUsagePage() {
  await requireAdminSection("usage");
  return <UsageArea />;
}
