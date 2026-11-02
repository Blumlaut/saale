import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { ShareViewer } from "@/components/chat/share-viewer";
import { getWorkspaceName } from "@/lib/branding/workspace";
import { loginPath } from "@/lib/auth/redirect";
import { loadSharedChat } from "@/lib/chat/share";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;

  const session = await auth.api.getSession({ headers: await headers() });
  const shared = await loadSharedChat(token, session?.user?.id ?? null);

  if (shared.state === "not-found") {
    notFound();
  }

  // A gated chat hands a signed-out visitor to the login page, so the transcript
  // never reaches a browser without an account.
  if (shared.state === "needs-auth") {
    redirect(loginPath(`/share/${token}`));
  }

  return (
    <ShareViewer
      token={token}
      workspaceName={await getWorkspaceName()}
      sessionTitle={shared.session.title}
      messages={shared.messages}
      isAuthenticated={!!session?.user}
    />
  );
}
