import { MessageSquare, Mail, ListTodo, type LucideIcon } from "lucide-react";

/**
 * A "purpose" is a distinct AI use-case in Saale that can have its own
 * model selection. Add a new entry here and everything (settings UI,
 * model resolution, etc.) picks it up automatically.
 */
export interface ModelPurpose {
  /** Unique key used in storage and resolution */
  id: string;
  /** Display name shown in settings */
  label: string;
  /** Short description shown in settings */
  description: string;
  /** Icon shown in the purpose selector */
  icon: LucideIcon;
}

/**
 * Registry of all model purposes.
 * Add new purposes here. the settings UI and model resolution scale automatically.
 */
export const MODEL_PURPOSES: Record<string, ModelPurpose> = {
  chat: {
    id: "chat",
    label: "Chat",
    description: "General AI chat conversations",
    icon: MessageSquare,
  },
  email_draft: {
    id: "email_draft",
    label: "Email Drafts",
    description: "AI-generated email reply drafts",
    icon: Mail,
  },
  jobs: {
    id: "jobs",
    label: "Jobs",
    description: "Scheduled AI jobs (summarization, classification, etc.)",
    icon: ListTodo,
  },
};

/**
 * Get all purposes as an array (sorted by insertion order).
 */
export function getAllPurposes(): ModelPurpose[] {
  return Object.values(MODEL_PURPOSES);
}

/**
 * Get a purpose by ID.
 */
export function getPurpose(id: string): ModelPurpose | undefined {
  return MODEL_PURPOSES[id];
}
