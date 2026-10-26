import { redirect } from "next/navigation";

/** The Plugins area has sections of its own; the bare URL opens the first one. */
export default function AdminPluginsPage() {
  redirect("/admin/plugins/installed");
}
