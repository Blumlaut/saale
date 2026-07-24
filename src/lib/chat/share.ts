import crypto from "crypto";

/**
 * Generate a random 32-character share token.
 */
export function generateShareToken(): string {
  return crypto.randomBytes(16).toString("hex");
}
