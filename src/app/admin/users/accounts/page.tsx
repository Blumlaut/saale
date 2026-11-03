import { requireAdminSection } from "@/lib/permissions/guards";
import { UsersArea } from "@/components/admin/users-area";

export default async function AdminAccountsPage() {
  await requireAdminSection("users");
  return <UsersArea />;
}
