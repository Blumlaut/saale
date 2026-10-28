import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginPath, PATH_HEADER, queryOf } from "@/lib/auth/redirect";

export default async function Home() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  // A browser opening the bare URL with a prompt has to reach the chat with it.
  const chat = `/dashboard/chat${queryOf(requestHeaders.get(PATH_HEADER))}`;

  if (session) {
    redirect(chat);
  }
  redirect(loginPath(chat));
}
