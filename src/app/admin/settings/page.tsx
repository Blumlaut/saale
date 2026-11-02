import { redirect } from "next/navigation";

/** The Settings area has sections of its own; the bare URL opens the first one. */
export default function AdminSettingsPage() {
  redirect("/admin/settings/signups");
}
