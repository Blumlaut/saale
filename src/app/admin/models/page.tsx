import { redirect } from "next/navigation";

/** The Models area has sections of its own; the bare URL opens the first one. */
export default function AdminModelsPage() {
  redirect("/admin/models/providers");
}
