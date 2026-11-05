import { getSsoStatus } from "@/lib/auth/sso";
import { SsoSection } from "@/components/admin/admin-settings/sso-section";

export default function AdminSettingsSsoPage() {
  return <SsoSection status={getSsoStatus()} />;
}
