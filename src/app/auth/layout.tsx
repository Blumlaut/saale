import type { Metadata } from "next";
import { getWorkspaceName } from "@/lib/branding/workspace";

// better-auth's React client uses React context which doesn't work during static prerendering
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await getWorkspaceName() };
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
