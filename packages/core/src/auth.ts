import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { User } from "./types.js";

const SALT_LEN = 16;

export function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(SALT_LEN).toString("hex");
  const hash = createHash("sha256").update(`${s}:${password}`).digest("hex");
  return `${s}$${hash}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, hash] = passwordHash.split("$");
  if (!salt || !hash) return false;
  const attempt = hashPassword(password, salt);
  const a = Buffer.from(attempt);
  const b = Buffer.from(passwordHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createUser(email: string, password: string): User {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("Invalid email");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  return {
    id: randomUUID(),
    email: normalized,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
}

/** Simple session tokens for the web app (not JWT; local demo auth). */
export function issueSessionToken(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const sig = createHash("sha256").update(`${userId}:${nonce}:heiss`).digest("hex");
  return Buffer.from(JSON.stringify({ userId, nonce, sig })).toString("base64url");
}

export function parseSessionToken(
  token: string,
): { userId: string; nonce: string; sig: string } | null {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const obj = JSON.parse(raw) as { userId?: string; nonce?: string; sig?: string };
    if (!obj.userId || !obj.nonce || !obj.sig) return null;
    const expected = createHash("sha256")
      .update(`${obj.userId}:${obj.nonce}:heiss`)
      .digest("hex");
    if (expected !== obj.sig) return null;
    return { userId: obj.userId, nonce: obj.nonce, sig: obj.sig };
  } catch {
    return null;
  }
}
