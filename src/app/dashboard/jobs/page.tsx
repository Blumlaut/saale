import { redirect } from "next/navigation";

/** Jobs has kinds of its own; the bare URL opens the first one. */
export default function JobsIndexPage() {
  redirect("/dashboard/jobs/agents");
}
