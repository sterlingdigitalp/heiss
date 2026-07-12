#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  JsonStore,
  createUser,
  verifyPassword,
  issueSessionToken,
  parseSessionToken,
  dropContent,
  seedDemoFarm,
} from "@heiss/core";
import { marketingHtml } from "./pages/marketing.js";
import { appHtml } from "./pages/app.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA =
  process.env.HEISS_DATA ?? join(homedir(), ".heiss");

function store(): JsonStore {
  mkdirSync(DATA, { recursive: true });
  return new JsonStore(join(DATA, "farm.json"));
}

function send(res: ServerResponse, code: number, data: unknown, type = "application/json"): void {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authUser(req: IncomingMessage, s: JsonStore) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const parsed = parseSessionToken(token);
  if (!parsed) return null;
  return s.state.users.find((u) => u.id === parsed.userId) ?? null;
}

export function createWebServer() {
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const s = store();

    try {
      if (url.pathname === "/" && req.method === "GET") {
        send(res, 200, marketingHtml(), "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/login" || url.pathname === "/signup") {
        send(res, 200, appHtml(), "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/health") {
        send(res, 200, { ok: true, service: "heiss-web" });
        return;
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
        // Ensure demo farm for Cloud Drop targets
        if (s.state.accounts.length === 0) seedDemoFarm(s);
        s.save();
        send(res, 200, {
          ok: true,
          user: { id: user.id, email: user.email },
          token: issueSessionToken(user.id),
        });
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
        send(res, 200, { user: { id: user.id, email: user.email } });
        return;
      }

      if (url.pathname === "/api/overview" && req.method === "GET") {
        if (s.state.accounts.length === 0) seedDemoFarm(s);
        send(res, 200, {
          devices: s.state.devices,
          accounts: s.state.accounts,
          queue: s.state.queue,
          activity: s.state.activity.slice(-40),
        });
        return;
      }

      if (url.pathname === "/api/accounts" && req.method === "GET") {
        if (s.state.accounts.length === 0) seedDemoFarm(s);
        send(res, 200, { accounts: s.state.accounts });
        return;
      }

      if (url.pathname === "/api/drop" && req.method === "POST") {
        const user = authUser(req, s);
        const json = JSON.parse(await readBody(req)) as {
          kind?: "video" | "carousel";
          mediaRef?: string;
          slides?: string[];
          caption?: string;
          music?: string;
          accountIds?: string[];
        };
        if (s.state.accounts.length === 0) seedDemoFarm(s);
        const accountIds = json.accountIds ?? [];
        // Validate accounts exist
        for (const id of accountIds) {
          if (!s.state.accounts.some((a) => a.id === id)) {
            send(res, 400, { error: `Unknown account ${id}` });
            return;
          }
        }
        const { content, queueItem } = dropContent({
          kind: json.kind ?? "video",
          mediaRef: json.mediaRef ?? "upload.bin",
          slides: json.slides,
          caption: json.caption ?? "",
          music: json.music,
          accountIds,
          createdBy: user?.id ?? "web-anonymous",
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
        send(res, 200, { queue: s.state.queue, contents: s.state.contents });
        return;
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
  server.listen(PORT, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${PORT}`, data: DATA }));
  });
}
