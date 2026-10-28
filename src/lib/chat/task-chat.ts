import { format, parseISO } from "date-fns";
import { startChatSession } from "@/lib/chat-session";
import type { Task } from "@/types/shared";

/**
 * Build the first message for a chat started from a task.
 */
export function buildTaskChatPrompt(task: Task, context?: string): string {
  const lines = [
    `You are an agent the user started to look into task ${task.id}.`,
    "",
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : null,
    `Priority: ${task.priority}`,
    task.dueDate ? `Due date: ${format(parseISO(task.dueDate), "EEEE, MMM d yyyy")}` : null,
    task.tags.length > 0 ? `Tags: ${task.tags.join(", ")}` : null,
    "",
    "Look into the task, take the next concrete steps, and keep the user informed of progress and results.",
  ].filter((line): line is string => line !== null);

  const trimmedContext = context?.trim();
  if (trimmedContext) {
    lines.splice(lines.length - 1, 0, "", "Additional user context:", trimmedContext);
  }

  return lines.join("\n");
}

/**
 * Create a chat session for a task and send the initial prompt that
 * hands the task (plus optional user context) to the agent.
 */
export async function startTaskChat(task: Task, context?: string): Promise<{ sessionId: string }> {
  const { id } = await startChatSession({
    title: `Task: ${task.title}`,
    message: buildTaskChatPrompt(task, context),
  });

  return { sessionId: id };
}
