import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

/** The red line above a form: what the server, or the request, said. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/** A quiet block of prose: a hint, or what happens next. */
export function NoteBanner({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-muted/60 text-muted-foreground flex items-start gap-2 rounded-2xl px-4 py-3 text-sm">
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
