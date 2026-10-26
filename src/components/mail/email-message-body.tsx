"use client";

import type { EmailMessageDetail } from "./types";

/**
 * A message's content, as sent when it has HTML and as plain text otherwise.
 */
export function EmailMessageBody({ message }: { message: EmailMessageDetail }) {
  if (message.bodyHtml) {
    return <div className="max-w-none" dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />;
  }

  return (
    <pre className="text-sm whitespace-pre-wrap">{message.bodyText || message.bodyPreview}</pre>
  );
}
