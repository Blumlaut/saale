import { redirect } from "next/navigation";

/** The Users area has sections of its own; the bare URL opens the first one. */
export default function AdminUsersIndexPage() {
  redirect("/admin/users/accounts");
}
