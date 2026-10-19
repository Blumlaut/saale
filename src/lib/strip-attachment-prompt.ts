const ATTACHMENT_LINE = /^\[(?:Image|File) attached: .*\]$/;

export function stripAttachmentPromptText(content: string): string {
  return content
    .split("\n")
    .filter((line) => !ATTACHMENT_LINE.test(line))
    .join("\n")
    .trim();
}
