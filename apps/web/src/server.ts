#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  JsonStore,
  createUser,
  verifyPassword,
  hashPassword,
  issueSessionToken,
  parseSessionToken,
  dropContent,
  seedDemoFarm,
  PLAN_TIERS,
  assertWithinPlan,
} from "@heiss/core";
import { marketingHtml } from "./pages/marketing.js";
import { appHtml } from "./pages/app.js";
import { contentPage } from "./pages/content.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
function dataRoot(): string {
  return process.env.HEISS_DATA ?? join(homedir(), ".heiss");
}

function store(): JsonStore {
  const data = dataRoot();
  mkdirSync(data, { recursive: true });
  return new JsonStore(join(data, "farm.json"));
}

function send(res: ServerResponse, code: number, data: unknown, type = "application/json"): void {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  const corsOrigin = process.env.HEISS_CORS_ORIGIN;
  res.writeHead(code, {
    "Content-Type": type,
    ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(type.startsWith("text/html") ? { "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } : {}),
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, code: number, data: Buffer, type: string, filename?: string): void {
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": data.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(filename ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}),
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class UploadLimitError extends Error {}

async function streamUpload(req: IncomingMessage, destination: string, maxBytes: number): Promise<number> {
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? new UploadLimitError("Upload exceeds the allowed file or plan limit") : null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, createWriteStream(destination, { flags: "wx" }));
    return size;
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

function authUser(req: IncomingMessage, s: JsonStore) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const parsed = parseSessionToken(token);
  if (!parsed) return null;
  return s.state.users.find((u) => u.id === parsed.userId) ?? null;
}

function authLicense(req: IncomingMessage, s: JsonStore) {
  const key = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const user = s.state.users.find((candidate) => candidate.licenseKey === key) ?? null;
  return user && subscriptionActive(user) ? user : null;
}

function subscriptionActive(user: { planId: string; trialEndsAt: string }): boolean {
  return user.planId !== "free" || new Date(user.trialEndsAt).getTime() > Date.now();
}

function checkoutUrl(planId: "solo" | "rack" | "scale") {
  return process.env[`HEISS_CHECKOUT_${planId.toUpperCase()}`];
}

function publicOrigin(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return (process.env.HEISS_PUBLIC_URL ?? `${forwarded}://${req.headers.host ?? `127.0.0.1:${PORT}`}`).replace(/\/$/, "");
}

function googleConfigured(): boolean {
  return Boolean(process.env.HEISS_GOOGLE_CLIENT_ID && process.env.HEISS_GOOGLE_CLIENT_SECRET && process.env.HEISS_PUBLIC_URL);
}

function googleState(): string {
  const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(18).toString("base64url"), issuedAt: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", process.env.HEISS_SESSION_SECRET ?? "heiss-development-session-secret")
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyGoogleState(state: string): boolean {
  const [payload, supplied] = state.split(".");
  if (!payload || !supplied) return false;
  const expected = createHmac("sha256", process.env.HEISS_SESSION_SECRET ?? "heiss-development-session-secret")
    .update(payload).digest("base64url");
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { issuedAt?: number };
    return typeof parsed.issuedAt === "number" && Date.now() - parsed.issuedAt < 10 * 60 * 1000 && parsed.issuedAt <= Date.now() + 30_000;
  } catch { return false; }
}

function userUploadPath(userId: string, path: string): string | null {
  const root = resolve(dataRoot(), "uploads", userId);
  const candidate = resolve(path);
  return candidate.startsWith(`${root}/`) && existsSync(candidate) ? candidate : null;
}

function platformProfiles() {
  if (process.env.HEISS_UI_PROFILES_JSON) {
    return JSON.parse(process.env.HEISS_UI_PROFILES_JSON);
  }
  const updatedAt = "2026-07-12T00:00:00.000Z";
  return {
    tiktok: { platform: "tiktok", bundleId: "com.zhiliaoapp.musically", revision: "2026.07.12-1", updatedAt, points: { home: { x: .10, y: .95 }, profile: { x: .91, y: .95 }, accountMenu: { x: .50, y: .08 }, like: { x: .90, y: .55 }, follow: { x: .88, y: .43 }, search: { x: .50, y: .94 }, create: { x: .50, y: .94 } } },
    instagram: { platform: "instagram", bundleId: "com.burbn.instagram", revision: "2026.07.12-1", updatedAt, points: { home: { x: .10, y: .95 }, profile: { x: .91, y: .95 }, accountMenu: { x: .50, y: .08 }, like: { x: .50, y: .48 }, follow: { x: .82, y: .16 }, search: { x: .30, y: .95 }, create: { x: .50, y: .95 } } },
    x: { platform: "x", bundleId: "com.atebits.Tweetie2", revision: "2026.07.12-1", updatedAt, points: { home: { x: .10, y: .95 }, profile: { x: .08, y: .08 }, accountMenu: { x: .50, y: .08 }, like: { x: .72, y: .72 }, follow: { x: .82, y: .16 }, search: { x: .30, y: .95 }, create: { x: .90, y: .88 } } },
    linkedin: { platform: "linkedin", bundleId: "com.linkedin.LinkedIn", revision: "2026.07.12-1", updatedAt, points: { home: { x: .10, y: .95 }, profile: { x: .08, y: .08 }, accountMenu: { x: .50, y: .08 }, like: { x: .18, y: .72 }, follow: { x: .82, y: .16 }, search: { x: .50, y: .08 }, create: { x: .50, y: .95 } } },
  };
}

function farmForUser(s: JsonStore, userId: string) {
  const accounts = s.state.accounts.filter((a) => a.ownerId === userId);
  const accountIds = new Set(accounts.map((a) => a.id));
  return {
    devices: s.state.devices.filter((d) => d.ownerId === userId),
    accounts,
    contents: s.state.contents.filter((c) => c.ownerId === userId),
    queue: s.state.queue.filter((q) => q.ownerId === userId),
    slots: s.state.slots.filter((slot) => accountIds.has(slot.accountId)),
    sessions: s.state.sessions.filter((session) => accountIds.has(session.accountId)),
    activity: s.state.activity.filter((event) => Boolean(event.accountId && accountIds.has(event.accountId))),
    proxies: s.state.proxies.filter((proxy) => proxy.ownerId === userId),
  };
}

export function createWebServer() {
  if (process.env.NODE_ENV === "production" && (process.env.HEISS_SESSION_SECRET?.length ?? 0) < 32) {
    throw new Error("HEISS_SESSION_SECRET must contain at least 32 characters in production");
  }
  const sharedStore = store();
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const s = sharedStore;

    try {
      if (url.pathname === "/" && req.method === "GET") {
        send(res, 200, marketingHtml(), "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/login" || url.pathname === "/signup") {
        send(res, 200, appHtml(), "text/html; charset=utf-8");
        return;
      }
      const staticPage = contentPage(url.pathname);
      if (staticPage && req.method === "GET") {
        send(res, 200, staticPage, "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/health") {
        send(res, 200, { ok: true, service: "heiss-web" });
        return;
      }
      if (url.pathname === "/download/mac" && req.method === "GET") {
        const download = process.env.HEISS_DOWNLOAD_PATH;
        if (!download || !existsSync(download)) { send(res, 404, { error: "Mac download is not configured" }); return; }
        sendBuffer(res, 200, readFileSync(download), "application/zip", "Heiss-mac-arm64.zip");
        return;
      }
      const origin = publicOrigin(req);
      if (url.pathname === "/robots.txt" && req.method === "GET") {
        send(res, 200, `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, "text/plain; charset=utf-8");
        return;
      }
      if (url.pathname === "/sitemap.xml" && req.method === "GET") {
        const paths = ["/", "/blog.html", "/resources.html", "/privacy.html", "/terms.html", ...["iphone-farm-guide", "how-to-warm-up-a-tiktok-account", "run-multiple-tiktok-accounts", "tiktok-automation-mac", "account-warmup-tiktok-instagram"].map((slug) => `/blog/${slug}.html`)];
        send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`, "application/xml; charset=utf-8");
        return;
      }
      if (url.pathname === "/llms.txt" && req.method === "GET") {
        send(res, 200, `# Heiss\n\n> Heiss runs social accounts on autopilot from real iPhones you own.\n\n- TikTok and Instagram: phased warmup plus scheduled video/carousel posting.\n- X and LinkedIn: warmup only.\n- Real wired iPhones, signed XCTest gestures, no unofficial social APIs.\n- Local-first farm state with optional hosted Cloud Drop.\n\nDashboard: ${origin}/app\nGuides: ${origin}/blog.html\n`, "text/plain; charset=utf-8");
        return;
      }

      if (url.pathname === "/api/auth/providers" && req.method === "GET") {
        send(res, 200, { google: googleConfigured(), magicLink: Boolean(process.env.HEISS_RESEND_API_KEY || process.env.HEISS_DEV_MAGIC_LINKS === "1") });
        return;
      }
      if (url.pathname === "/api/auth/google" && req.method === "GET") {
        if (!googleConfigured()) { send(res, 503, { error: "Google sign-in is not configured" }); return; }
        const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorize.searchParams.set("client_id", process.env.HEISS_GOOGLE_CLIENT_ID!);
        authorize.searchParams.set("redirect_uri", `${publicOrigin(req)}/api/auth/google/callback`);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("scope", "openid email profile");
        authorize.searchParams.set("state", googleState());
        authorize.searchParams.set("prompt", "select_account");
        res.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" }); res.end();
        return;
      }
      if (url.pathname === "/api/auth/google/callback" && req.method === "GET") {
        if (!googleConfigured() || !verifyGoogleState(url.searchParams.get("state") ?? "") || !url.searchParams.get("code")) {
          send(res, 401, { error: "Google sign-in request is invalid or expired" }); return;
        }
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: url.searchParams.get("code")!, client_id: process.env.HEISS_GOOGLE_CLIENT_ID!,
            client_secret: process.env.HEISS_GOOGLE_CLIENT_SECRET!, redirect_uri: `${publicOrigin(req)}/api/auth/google/callback`,
            grant_type: "authorization_code",
          }),
        });
        if (!tokenResponse.ok) { send(res, 401, { error: "Google rejected the sign-in code" }); return; }
        const tokens = await tokenResponse.json() as { access_token?: string };
        const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token ?? ""}` } });
        if (!profileResponse.ok) { send(res, 401, { error: "Google profile lookup failed" }); return; }
        const profile = await profileResponse.json() as { email?: string; email_verified?: boolean };
        const email = (profile.email ?? "").trim().toLowerCase();
        if (!email.includes("@") || profile.email_verified === false) { send(res, 401, { error: "Google email is not verified" }); return; }
        let user = s.state.users.find((candidate) => candidate.email === email);
        if (!user) {
          user = createUser(email, randomBytes(32).toString("base64url"));
          s.state.users.push(user); seedDemoFarm(s, user.id);
        }
        const token = randomBytes(32).toString("base64url");
        s.state.magicLinks = s.state.magicLinks.filter((link) => !link.usedAt && new Date(link.expiresAt).getTime() > Date.now());
        s.state.magicLinks.push({
          id: randomUUID(), userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        });
        s.save();
        res.writeHead(302, { Location: `${publicOrigin(req)}/login?magic=${encodeURIComponent(token)}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end();
        return;
      }

      if (url.pathname === "/api/runner/sync" && req.method === "POST") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid license key" }); return; }
        const json = JSON.parse(await readBody(req)) as {
          devices?: Array<{ id: string; name: string; udid: string; online: boolean; createdAt: string }>;
          accounts?: Array<{ id: string; deviceId: string; platform: "tiktok"|"instagram"|"x"|"linkedin"; handle: string; stage: "fresh"|"warmed_up"|"matured"|"kept_warm"|"posting"; trustScore: number; searchTerms: string[]; createdAt: string; lastWarmupAt?: string; lastPostAt?: string }>;
          slots?: Array<{ id: string; accountId: string; timeOfDay: string; enabled: boolean }>;
        };
        const incomingDevices = json.devices ?? [];
        const incomingAccounts = json.accounts ?? [];
        const plan = PLAN_TIERS.find((tier) => tier.id === user.planId) ?? PLAN_TIERS[0]!;
        assertWithinPlan(plan, incomingDevices.length, incomingAccounts.length);
        const deviceMap = new Map<string, string>();
        for (const device of incomingDevices) {
          const cloudId = `${user.id}:${device.id}`;
          deviceMap.set(device.id, cloudId);
          const row = { ...device, id: cloudId, sourceId: device.id, ownerId: user.id };
          const index = s.state.devices.findIndex((item) => item.id === cloudId);
          if (index >= 0) s.state.devices[index] = row; else s.state.devices.push(row);
        }
        const accountMap = new Map<string, string>();
        for (const account of incomingAccounts) {
          const cloudId = `${user.id}:${account.id}`;
          accountMap.set(account.id, cloudId);
          const row = { ...account, id: cloudId, sourceId: account.id, ownerId: user.id, deviceId: deviceMap.get(account.deviceId) ?? `${user.id}:${account.deviceId}` };
          const index = s.state.accounts.findIndex((item) => item.id === cloudId);
          if (index >= 0) s.state.accounts[index] = row; else s.state.accounts.push(row);
        }
        if (incomingAccounts.length > 0) {
          const realIds = new Set(accountMap.values());
          const demos = s.state.accounts.filter((a) => a.ownerId === user.id && !a.sourceId);
          for (const item of s.state.queue.filter((q) => q.ownerId === user.id)) {
            item.accountIds = item.accountIds.map((id) => {
              const demo = demos.find((a) => a.id === id);
              const replacement = demo && incomingAccounts.find((a) => a.handle === demo.handle && a.platform === demo.platform);
              return replacement ? accountMap.get(replacement.id)! : id;
            }).filter((id) => realIds.has(id));
          }
          const demoIds = new Set(demos.map((a) => a.id));
          s.state.accounts = s.state.accounts.filter((a) => a.ownerId !== user.id || Boolean(a.sourceId));
          s.state.devices = s.state.devices.filter((d) => d.ownerId !== user.id || Boolean(d.sourceId));
          s.state.slots = s.state.slots.filter((slot) => !demoIds.has(slot.accountId));
        }
        for (const slot of json.slots ?? []) {
          const accountId = accountMap.get(slot.accountId);
          if (!accountId) continue;
          const id = `${user.id}:${slot.id}`;
          const row = { ...slot, id, accountId };
          const index = s.state.slots.findIndex((item) => item.id === id);
          if (index >= 0) s.state.slots[index] = row; else s.state.slots.push(row);
        }
        s.save();
        send(res, 200, { ok: true, accountMap: Object.fromEntries(accountMap), devices: incomingDevices.length, accounts: incomingAccounts.length });
        return;
      }

      if (url.pathname === "/api/runner/license" && req.method === "POST") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid or expired license key" }); return; }
        const plan = PLAN_TIERS.find((tier) => tier.id === user.planId) ?? PLAN_TIERS[0]!;
        send(res, 200, { ok: true, plan, trialEndsAt: user.trialEndsAt, email: user.email });
        return;
      }

      if (url.pathname === "/api/runner/profiles" && req.method === "POST") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid or expired license key" }); return; }
        const profiles = platformProfiles();
        const signature = createHmac("sha256", user.licenseKey).update(JSON.stringify(profiles)).digest("hex");
        send(res, 200, { ok: true, profiles, signature });
        return;
      }

      if (url.pathname === "/api/runner/claim" && req.method === "POST") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid license key" }); return; }
        const json = JSON.parse(await readBody(req)) as { runnerId?: string };
        const now = Date.now();
        const item = s.state.queue.find((q) => q.ownerId === user.id && (
          q.status === "queued" ||
          (q.status === "claimed" && q.claimedAt && now - new Date(q.claimedAt).getTime() > 10 * 60 * 1000)
        ));
        if (!item) { send(res, 200, { ok: true, item: null }); return; }
        item.status = "claimed"; item.claimedBy = json.runnerId ?? "mac"; item.claimedAt = new Date().toISOString();
        const content = s.state.contents.find((c) => c.id === item.contentId && c.ownerId === user.id);
        if (!content) { send(res, 409, { error: "Queue content missing" }); return; }
        const targets = item.accountIds.map((id) => s.state.accounts.find((a) => a.id === id && a.ownerId === user.id)).filter(Boolean).map((a) => ({ cloudId: a!.id, sourceId: a!.sourceId, handle: a!.handle, platform: a!.platform }));
        s.save();
        const refs = [...new Set([content.mediaRef, ...(content.slides ?? [])])];
        send(res, 200, {
          ok: true,
          item,
          content: {
            ...content,
            mediaRef: `/api/runner/media/${content.id}/0`,
            slides: content.kind === "carousel" ? refs.map((_, index) => `/api/runner/media/${content.id}/${index}`) : undefined,
            mediaNames: refs.map((ref) => basename(ref)),
          },
          targets,
        });
        return;
      }

      if (url.pathname.startsWith("/api/runner/media/") && req.method === "GET") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid license key" }); return; }
        const [rawId, rawIndex] = url.pathname.slice("/api/runner/media/".length).split("/");
        const id = decodeURIComponent(rawId ?? "");
        const index = Number(rawIndex ?? 0);
        const content = s.state.contents.find((c) => c.id === id && c.ownerId === user.id);
        const refs = content ? [...new Set([content.mediaRef, ...(content.slides ?? [])])] : [];
        const mediaPath = refs[index] ? userUploadPath(user.id, refs[index]!) : null;
        if (!mediaPath) { send(res, 404, { error: "Media not found" }); return; }
        const ext = mediaPath.split(".").pop()?.toLowerCase();
        const type = ext === "mp4" ? "video/mp4" : ext === "mov" ? "video/quicktime" : ext === "png" ? "image/png" : "application/octet-stream";
        sendBuffer(res, 200, readFileSync(mediaPath), type);
        return;
      }

      if (url.pathname === "/api/runner/complete" && req.method === "POST") {
        const user = authLicense(req, s);
        if (!user) { send(res, 401, { error: "Invalid license key" }); return; }
        const json = JSON.parse(await readBody(req)) as { queueId?: string; sourceAccountId?: string };
        const item = s.state.queue.find((q) => q.id === json.queueId && q.ownerId === user.id);
        const account = s.state.accounts.find((a) => a.sourceId === json.sourceAccountId && a.ownerId === user.id);
        if (!item || !account || !item.accountIds.includes(account.id)) { send(res, 404, { error: "Queue target not found" }); return; }
        item.postedAccountIds = [...new Set([...(item.postedAccountIds ?? []), account.id])];
        const done = item.accountIds.every((id) => item.postedAccountIds!.includes(id));
        item.status = done ? "posted" : "claimed";
        if (done) {
          item.postedAt = new Date().toISOString();
          const content = s.state.contents.find((candidate) => candidate.id === item.contentId && candidate.ownerId === user.id);
          for (const ref of new Set(content ? [content.mediaRef, ...(content.slides ?? [])] : [])) {
            const safe = userUploadPath(user.id, ref);
            if (safe) rmSync(safe, { force: true });
          }
        }
        s.save(); send(res, 200, { ok: true, done, item }); return;
      }

      if (url.pathname === "/api/signup" && req.method === "POST") {
        const json = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        const email = (json.email ?? "").trim().toLowerCase();
        if (s.state.users.some((u) => u.email === email)) {
          send(res, 409, { error: "User exists" });
          return;
        }
        const user = createUser(email, json.password ?? "");
        s.state.users.push(user);
        // Isolated starter farm; a real Mac sync replaces these demo rows.
        seedDemoFarm(s, user.id);
        s.save();
        send(res, 200, {
          ok: true,
          user: { id: user.id, email: user.email },
          token: issueSessionToken(user.id),
          licenseKey: user.licenseKey,
        });
        return;
      }

      if (url.pathname === "/api/magic/request" && req.method === "POST") {
        const json = JSON.parse(await readBody(req)) as { email?: string };
        const email = (json.email ?? "").trim().toLowerCase();
        if (!email.includes("@")) { send(res, 400, { error: "Invalid email" }); return; }
        let user = s.state.users.find((candidate) => candidate.email === email);
        if (!user) {
          user = createUser(email, randomBytes(24).toString("base64url"));
          s.state.users.push(user);
          seedDemoFarm(s, user.id);
        }
        const token = randomBytes(32).toString("base64url");
        s.state.magicLinks = s.state.magicLinks.filter((link) => !link.usedAt && new Date(link.expiresAt).getTime() > Date.now());
        s.state.magicLinks.push({
          id: randomUUID(), userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        });
        s.save();
        const origin = publicOrigin(req);
        const link = `${origin}/login?magic=${encodeURIComponent(token)}`;
        const resendKey = process.env.HEISS_RESEND_API_KEY;
        if (resendKey) {
          if (!process.env.HEISS_PUBLIC_URL) { send(res, 503, { error: "HEISS_PUBLIC_URL is required for email sign-in" }); return; }
          const emailResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: process.env.HEISS_EMAIL_FROM ?? "Heiss <login@heiss.local>",
              to: [email], subject: "Sign in to Heiss",
              html: `<p>Use this link to sign in. It expires in 15 minutes.</p><p><a href="${link}">Sign in to Heiss</a></p>`,
            }),
          });
          if (!emailResponse.ok) throw new Error(`Email provider rejected the sign-in message (${emailResponse.status})`);
        } else if (process.env.HEISS_DEV_MAGIC_LINKS !== "1") {
          send(res, 503, { error: "Email sign-in is not configured" }); return;
        }
        send(res, 200, {
          ok: true,
          message: "Check your email for a sign-in link",
          ...(process.env.HEISS_DEV_MAGIC_LINKS === "1" ? { devLink: link, devToken: token } : {}),
        });
        return;
      }

      if (url.pathname === "/api/magic/verify" && req.method === "POST") {
        const json = JSON.parse(await readBody(req)) as { token?: string };
        const hash = createHash("sha256").update(json.token ?? "").digest("hex");
        const link = s.state.magicLinks.find((candidate) => candidate.tokenHash === hash && !candidate.usedAt && new Date(candidate.expiresAt).getTime() > Date.now());
        const user = link ? s.state.users.find((candidate) => candidate.id === link.userId) : undefined;
        if (!link || !user) { send(res, 401, { error: "Sign-in link is invalid or expired" }); return; }
        link.usedAt = new Date().toISOString(); s.save();
        send(res, 200, { ok: true, user: { id: user.id, email: user.email }, token: issueSessionToken(user.id) });
        return;
      }

      if (url.pathname === "/api/login" && req.method === "POST") {
        const json = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        const email = (json.email ?? "").trim().toLowerCase();
        const user = s.state.users.find((u) => u.email === email);
        if (!user || !verifyPassword(json.password ?? "", user.passwordHash)) {
          send(res, 401, { error: "Invalid credentials" });
          return;
        }
        if (!user.passwordHash.startsWith("scrypt$")) {
          user.passwordHash = hashPassword(json.password ?? "");
          s.save();
        }
        if (farmForUser(s, user.id).accounts.length === 0) seedDemoFarm(s, user.id);
        send(res, 200, {
          ok: true,
          user: { id: user.id, email: user.email },
          token: issueSessionToken(user.id),
        });
        return;
      }

      if (url.pathname === "/api/me" && req.method === "GET") {
        const user = authUser(req, s);
        if (!user) {
          send(res, 401, { error: "Unauthorized" });
          return;
        }
        const plan = PLAN_TIERS.find((p) => p.id === user.planId) ?? PLAN_TIERS[0];
        send(res, 200, {
          user: {
            id: user.id,
            email: user.email,
            planId: user.planId,
            licenseKey: user.licenseKey,
            trialEndsAt: user.trialEndsAt,
          },
          plan,
          checkoutPlans: (["solo", "rack", "scale"] as const).filter((id) => Boolean(checkoutUrl(id))),
          downloadAvailable: Boolean(process.env.HEISS_DOWNLOAD_PATH && existsSync(process.env.HEISS_DOWNLOAD_PATH)),
        });
        return;
      }

      if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        const json = JSON.parse(await readBody(req)) as { planId?: "solo"|"rack"|"scale" };
        const planId = json.planId;
        const configured = planId ? checkoutUrl(planId) : undefined;
        if (!planId || !configured) { send(res, 503, { error: "Checkout is not configured for this plan" }); return; }
        const checkout = new URL(configured);
        checkout.searchParams.set("checkout[custom][user_id]", user.id);
        checkout.searchParams.set("checkout[email]", user.email);
        send(res, 200, { ok: true, url: checkout.toString() });
        return;
      }

      if (url.pathname === "/api/billing/webhook" && req.method === "POST") {
        const secret = process.env.HEISS_LEMON_WEBHOOK_SECRET;
        if (!secret) { send(res, 503, { error: "Billing webhook is not configured" }); return; }
        const raw = await readBody(req);
        const supplied = String(req.headers["x-signature"] ?? "");
        const expected = createHmac("sha256", secret).update(raw).digest("hex");
        const a = Buffer.from(supplied, "hex"), b = Buffer.from(expected, "hex");
        if (a.length !== b.length || !timingSafeEqual(a, b)) { send(res, 401, { error: "Invalid webhook signature" }); return; }
        const payload = JSON.parse(raw) as any;
        const attrs = payload.data?.attributes ?? {};
        const custom = payload.meta?.custom_data ?? attrs.custom_data ?? {};
        const user = s.state.users.find((candidate) => candidate.id === custom.user_id || candidate.email === attrs.user_email);
        if (!user) { send(res, 404, { error: "Billing user not found" }); return; }
        const event = String(payload.meta?.event_name ?? "");
        const variant = String(attrs.variant_id ?? "");
        const variantMap: Record<string, "solo"|"rack"|"scale"> = {};
        for (const id of ["solo", "rack", "scale"] as const) {
          const configured = process.env[`HEISS_LEMON_VARIANT_${id.toUpperCase()}`];
          if (configured) variantMap[configured] = id;
        }
        if (["subscription_cancelled", "subscription_expired"].includes(event)) {
          user.planId = "free";
          user.trialEndsAt = new Date(0).toISOString();
        } else if (variantMap[variant]) {
          user.planId = variantMap[variant]!;
          user.billingCustomerId = String(attrs.customer_id ?? "");
          user.subscriptionId = String(payload.data?.id ?? "");
        }
        s.save(); send(res, 200, { ok: true }); return;
      }

      if (url.pathname === "/api/overview" && req.method === "GET") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        const farm = farmForUser(s, user.id);
        send(res, 200, {
          devices: farm.devices,
          accounts: farm.accounts,
          queue: farm.queue,
          activity: farm.activity.slice(-40),
          slots: farm.slots,
          sessions: farm.sessions.slice(-25),
          proxies: farm.proxies,
        });
        return;
      }

      if (url.pathname === "/api/accounts" && req.method === "GET") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        send(res, 200, { accounts: farmForUser(s, user.id).accounts });
        return;
      }

      if (url.pathname === "/api/uploads" && req.method === "POST") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        if (!subscriptionActive(user)) { send(res, 402, { error: "Free trial expired" }); return; }
        const original = basename(url.searchParams.get("filename") ?? "upload.bin")
          .replace(/[^a-zA-Z0-9._-]/g, "-");
        const uploads = join(dataRoot(), "uploads", user.id);
        const plan = PLAN_TIERS.find((tier) => tier.id === user.planId) ?? PLAN_TIERS[0]!;
        const used = existsSync(uploads)
          ? readdirSync(uploads).reduce((sum, name) => sum + statSync(join(uploads, name)).size, 0)
          : 0;
        const planRemaining = plan.cloudDropGb === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, plan.cloudDropGb * 1024 * 1024 * 1024 - used);
        const fileLimit = Math.max(1, Number(process.env.HEISS_MAX_UPLOAD_MB ?? 2048)) * 1024 * 1024;
        const allowed = Math.min(planRemaining, fileLimit);
        const declared = Number(req.headers["content-length"] ?? 0);
        if (allowed <= 0 || (declared > 0 && declared > allowed)) {
          send(res, 413, { error: `Cloud Drop upload limit reached for ${plan.name}` }); return;
        }
        mkdirSync(uploads, { recursive: true });
        const storedName = `${Date.now()}-${randomUUID()}-${original}`;
        const storedPath = join(uploads, storedName);
        let size: number;
        try { size = await streamUpload(req, storedPath, allowed); }
        catch (error) {
          if (error instanceof UploadLimitError) { send(res, 413, { error: `Cloud Drop upload limit reached for ${plan.name}` }); return; }
          throw error;
        }
        if (size === 0) { rmSync(storedPath, { force: true }); send(res, 400, { error: "Empty upload" }); return; }
        if (plan.cloudDropGb !== null) {
          const limit = plan.cloudDropGb * 1024 * 1024 * 1024;
          const total = readdirSync(uploads).reduce((sum, name) => sum + statSync(join(uploads, name)).size, 0);
          if (total > limit) { rmSync(storedPath, { force: true }); send(res, 413, { error: `Cloud Drop storage limit reached for ${plan.name}` }); return; }
        }
        send(res, 200, { ok: true, mediaRef: storedPath, name: original, size });
        return;
      }

      if (url.pathname === "/api/drop" && req.method === "POST") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        if (!subscriptionActive(user)) { send(res, 402, { error: "Free trial expired" }); return; }
        const json = JSON.parse(await readBody(req)) as {
          kind?: "video" | "carousel";
          mediaRef?: string;
          slides?: string[];
          caption?: string;
          music?: string;
          accountIds?: string[];
        };
        const accountIds = json.accountIds ?? [];
        if (user.planId === "free" && (json.kind === "carousel" || Boolean(json.music))) {
          send(res, 403, { error: "Carousels and music require Solo or higher" }); return;
        }
        const farm = farmForUser(s, user.id);
        const mediaRefs = [json.mediaRef, ...(json.slides ?? [])]
          .filter((ref): ref is string => Boolean(ref));
        if (mediaRefs.length === 0 || mediaRefs.some((ref) => !userUploadPath(user.id, ref))) {
          send(res, 400, { error: "Media must come from your authenticated Cloud Drop uploads" }); return;
        }
        // Validate accounts exist
        for (const id of accountIds) {
          if (!farm.accounts.some((a) => a.id === id)) {
            send(res, 400, { error: `Unknown account ${id}` });
            return;
          }
        }
        const { content, queueItem } = dropContent({
          ownerId: user.id,
          kind: json.kind ?? "video",
          mediaRef: json.mediaRef ?? "upload.bin",
          slides: json.slides,
          caption: json.caption ?? "",
          music: json.music,
          accountIds,
          createdBy: user.id,
        });
        s.state.contents.push(content);
        s.state.queue.push(queueItem);
        s.save();
        send(res, 200, {
          ok: true,
          content,
          queueItem,
          linkedAccountIds: queueItem.accountIds,
          claimable: queueItem.status === "queued",
          claimableByRunner: true,
        });
        return;
      }

      if (url.pathname === "/api/queue" && req.method === "GET") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        const farm = farmForUser(s, user.id);
        send(res, 200, { queue: farm.queue, contents: farm.contents });
        return;
      }

      if (url.pathname === "/api/queue/cancel" && req.method === "POST") {
        const user = authUser(req, s);
        if (!user) { send(res, 401, { error: "Unauthorized" }); return; }
        const json = JSON.parse(await readBody(req)) as { queueId?: string };
        const item = s.state.queue.find((queue) => queue.id === json.queueId && queue.ownerId === user.id);
        if (!item) { send(res, 404, { error: "Queue item not found" }); return; }
        if (item.status !== "queued") { send(res, 409, { error: `Cannot cancel content in ${item.status} status` }); return; }
        item.status = "cancelled";
        const content = s.state.contents.find((candidate) => candidate.id === item.contentId && candidate.ownerId === user.id);
        for (const ref of new Set(content ? [content.mediaRef, ...(content.slides ?? [])] : [])) {
          const safe = userUploadPath(user.id, ref); if (safe) rmSync(safe, { force: true });
        }
        s.save(); send(res, 200, { ok: true, item }); return;
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

const isMain =
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js") ||
  process.env.HEISS_WEB_LISTEN === "1";

if (isMain) {
  const server = createWebServer();
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ ok: true, url: `http://${HOST}:${PORT}`, data: dataRoot() }));
  });
}
