/**
 * The variables Saale sets for every command in a chat's workspace.
 *
 * A leaf module: the settings panel renders this list in the browser and the
 * system prompt is built from the names on the server.
 */
export const SAALE_SESSION_ENV = [
  { name: "SAALE_CHAT_ID", what: "the chat the command belongs to" },
  { name: "SAALE_MODEL", what: "the model answering in that chat" },
  { name: "SAALE_MODEL_PROVIDER", what: "the provider serving that model" },
  { name: "SAALE_THINKING_LEVEL", what: "the thinking level it runs at" },
] as const;

/** The names alone, for a prompt or a check. */
export const SESSION_ENV_NAMES: string[] = SAALE_SESSION_ENV.map((variable) => variable.name);
