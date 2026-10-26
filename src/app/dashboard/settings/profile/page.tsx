import { redirect } from "next/navigation";
import { Page, PageScroll } from "@/components/layout/page";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ProfileSection } from "../sections/profile-section";

// The account details come from the row, not the session: a session carries the
// name and image it was issued with, and this page edits exactly those.
export default async function SettingsProfilePage() {
  const session = await getSession();
  if (!session?.user) redirect("/auth/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, username: true, email: true, image: true, createdAt: true },
  });

  if (!user) redirect("/auth/login");

  return (
    <Page>
      <PageScroll className="space-y-6">
        <ProfileSection
          user={{
            name: user.name,
            username: user.username,
            email: user.email,
            image: user.image,
            createdAt: user.createdAt.toISOString(),
          }}
        />
      </PageScroll>
    </Page>
  );
}
