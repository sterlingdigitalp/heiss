import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { User } from "./types.js";

const SALT_LEN = 16;
const SESSION_SECRET = process.env.HEISS_SESSION_SECRET ?? randomBytes(32).toString("hex");

export function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(SALT_LEN).toString("hex");
  const hash = scryptSync(password, Buffer.from(s, "hex"), 32).toString("hex");
  return `scrypt$${s}$${hash}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const parts = passwordHash.split("$");
  if (parts[0] !== "scrypt") {
    // Read-only migration path for farms created by early local builds.
    const [salt, hash] = parts;
    if (!salt || !hash) return false;
    const attempt = `${salt}$${createHash("sha256").update(`${salt}:${password}`).digest("hex")}`;
    const a = Buffer.from(attempt); const b = Buffer.from(passwordHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const [, salt, hash] = parts;
  if (!salt || !hash) return false;
  const attempt = scryptSync(password, Buffer.from(salt, "hex"), 32).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
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
    planId: "free",
    licenseKey: `HEISS-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`,
    trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/** Signed, expiring session token for the web dashboard. */
export function issueSessionToken(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const sig = createHmac("sha256", SESSION_SECRET).update(`${userId}:${nonce}:${exp}`).digest("hex");
  return Buffer.from(JSON.stringify({ userId, nonce, exp, sig })).toString("base64url");
}

export function parseSessionToken(
  token: string,
): { userId: string; nonce: string; exp: number; sig: string } | null {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const obj = JSON.parse(raw) as { userId?: string; nonce?: string; exp?: number; sig?: string };
    if (!obj.userId || !obj.nonce || !obj.exp || !obj.sig || obj.exp < Date.now()) return null;
    const expected = createHmac("sha256", SESSION_SECRET)
      .update(`${obj.userId}:${obj.nonce}:${obj.exp}`).digest("hex");
    const a = Buffer.from(expected, "hex"); const b = Buffer.from(obj.sig, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { userId: obj.userId, nonce: obj.nonce, exp: obj.exp, sig: obj.sig };
  } catch {
    return null;
  }
}
