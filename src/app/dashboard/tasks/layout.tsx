import { requireFeaturePage } from "@/lib/permissions/guards";

export default async function FeatureLayout({ children }: { children: React.ReactNode }) {
  await requireFeaturePage("tasks");
  return children;
}
