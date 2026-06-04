import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

let _key: Buffer | null = null;

/** Reset cached key (for testing). */
export function _resetKey(): void {
  _key = null;
}

function getKey(): Buffer {
  if (_key) return _key;

  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required (64-char hex string = 32 bytes / 256-bit key)",
    );
  }

  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes / 256-bit key), got ${ENCRYPTION_KEY.length} chars (${key.length} bytes)`,
    );
  }

  _key = key;
  return _key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a hex-encoded string: iv (16 bytes) + authTag (16 bytes) + ciphertext.
 */
export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(16);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a hex-encoded string produced by `encrypt`.
 * Returns the original plaintext.
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  const parts = encrypted.split(":");
  if (parts.length < 3) {
    throw new Error("Invalid encrypted data format");
  }
  const [ivHex, authTagHex, ...ciphertextParts] = parts;
  const ciphertextHex = ciphertextParts.join(":"); // Handle colons in ciphertext

  // Guard above (parts.length < 3) ensures ivHex and authTagHex are defined
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
