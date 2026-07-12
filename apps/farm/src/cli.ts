#!/usr/bin/env node
/**
 * heiss-farm — local controller (physical iPhones only, no simulator).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  JsonStore,
  FarmOrchestrator,
  dropContent,
  createUser,
  verifyPassword,
  issueSessionToken,
  parseSessionToken,
  assertCanAddAccount,
  createSlot,
  type Platform,
  type AccountStage,
} from "@heiss/core";
import {
  RealIosDriver,
  createProductionTransport,
  listUsbIphones,
  pollUntilReady,
  getSetupStatus,
  setupDeviceAndRunner,
  downloadBuildInstallRunner,
  planSigning,
  saveSigningConfig,
  resolveSigningConfig,
  detectLocalTeams,
} from "@heiss/device";
import { defaultDataDir, farmStatePath } from "./paths.js";
import { randomUUID } from "node:crypto";

function usage(): string {
  return `heiss-farm — Heiss local farm controller (real iPhones only)

Setup:
  heiss-farm setup status [--data DIR]
  heiss-farm setup device [--udid UDID] [--wait-ms N]
  heiss-farm runner install [--udid UDID] [--team TEAM_ID]
  heiss-farm signing show | set --team TEAM_ID | set --asc-key PATH --key-id ID --issuer ID
  heiss-farm devices list | sync [--data DIR]

Farm:
  heiss-farm status [--data DIR]
  heiss-farm run [--time HH:mm] [--data DIR] [--interrupt N]
  heiss-farm resume [--data DIR]
  heiss-farm register-device <name> <udid>
  heiss-farm add-account <deviceId> <platform> <handle> [--stage STAGE] [--terms a,b]
  heiss-farm add-slot <accountId> <HH:mm>
  heiss-farm drop --accounts ID,ID --caption TEXT --media REF [--music M] [--carousel]
  heiss-farm start-warmups [--time HH:mm] [--data DIR]   # alias: run after setup
  heiss-farm serve-api [--port 8787]

Env:
  HEISS_DATA          Data directory (default ~/.heiss)
  HEISS_TEAM_ID       Xcode DEVELOPMENT_TEAM
  HEISS_ASC_KEY_PATH  App Store Connect .p8
  HEISS_ASC_KEY_ID    ASC key id
  HEISS_ASC_ISSUER_ID ASC issuer id

No simulator. Requires USB iPhone + HeissRunner.
`;
}

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function openStore(args: string[]): JsonStore {
  const data = getArg(args, "--data") ?? defaultDataDir();
  mkdirSync(data, { recursive: true });
  return new JsonStore(farmStatePath(data));
}

/** Production driver only — real USB transport, never simulator. */
function makeDriver(): RealIosDriver {
  return new RealIosDriver(createProductionTransport());
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    process.exit(0);
  }

  // ── Setup ──────────────────────────────────────────────
  if (cmd === "setup" && args[1] === "status") {
    const store = openStore(args);
    const status = await getSetupStatus({
      hasRegisteredDevice: store.state.devices.length > 0,
      hasAccount: store.state.accounts.length > 0,
      hasWarmupSession: store.state.sessions.some(
        (s) => s.kind === "warmup" || s.kind === "keep_warm" || s.kind === "post",
      ),
    });
    print({ ok: true, ...status });
    return;
  }

  if (cmd === "setup" && args[1] === "device") {
    const udid = getArg(args, "--udid");
    const waitMs = Number(getArg(args, "--wait-ms") ?? 120_000);
    const device = await pollUntilReady({
      udid,
      timeoutMs: waitMs,
      onTick: (devs, elapsed) => {
        if (elapsed % 4000 < 2100) {
          process.stderr.write(
            `waiting for iPhone… ${devs.length} seen, ${Math.round(elapsed / 1000)}s\n`,
          );
        }
      },
    });
    const store = openStore(args);
    let existing = store.state.devices.find((d) => d.udid === device.udid);
    if (!existing) {
      existing = {
        id: randomUUID(),
        name: device.name,
        udid: device.udid,
        online: true,
        createdAt: new Date().toISOString(),
      };
      store.state.devices.push(existing);
      store.save();
    } else {
      existing.online = true;
      existing.name = device.name;
      store.save();
    }
    print({
      ok: true,
      device: existing,
      usb: device,
      next: "heiss-farm runner install --udid " + device.udid,
    });
    return;
  }

  if (cmd === "runner" && args[1] === "install") {
    const udid = getArg(args, "--udid");
    const team = getArg(args, "--team");
    const repoRoot = resolve(process.cwd());
    const result = await downloadBuildInstallRunner({
      udid,
      repoRoot,
      signing: team ? { method: "xcode", teamId: team } : undefined,
      waitForDevice: true,
    });
    // auto-register device
    const store = openStore(args);
    if (!store.state.devices.find((d) => d.udid === result.udid)) {
      store.state.devices.push({
        id: randomUUID(),
        name: result.deviceName,
        udid: result.udid,
        online: true,
        createdAt: new Date().toISOString(),
      });
      store.save();
    }
    print({
      ...result,
      humanNext:
        "On iPhone: Settings → General → VPN & Device Management → Trust developer. Open Heiss Runner. Then add-account.",
    });
    return;
  }

  if (cmd === "signing" && args[1] === "show") {
    const cfg = resolveSigningConfig();
    let plan;
    try {
      plan = planSigning(cfg);
    } catch (e) {
      plan = { error: e instanceof Error ? e.message : String(e) };
    }
    const teams = await detectLocalTeams();
    print({ ok: true, config: cfg, plan, detectedCodesignTeams: teams });
    return;
  }

  if (cmd === "signing" && args[1] === "set") {
    const team = getArg(args, "--team");
    const ascKey = getArg(args, "--asc-key");
    const keyId = getArg(args, "--key-id");
    const issuer = getArg(args, "--issuer");
    if (ascKey && keyId && issuer) {
      saveSigningConfig({
        method: "asc",
        ascKeyPath: ascKey,
        ascKeyId: keyId,
        ascIssuerId: issuer,
        teamId: team,
        bundleId: "so.heiss.runner",
      });
    } else if (team) {
      saveSigningConfig({
        method: "xcode",
        teamId: team,
        bundleId: "so.heiss.runner",
      });
    } else {
      console.error("signing set requires --team TEAM or --asc-key --key-id --issuer");
      process.exit(1);
    }
    print({ ok: true, config: resolveSigningConfig() });
    return;
  }

  if (cmd === "devices" && args[1] === "list") {
    const devices = await listUsbIphones();
    print({ ok: true, devices, count: devices.length });
    return;
  }

  if (cmd === "devices" && args[1] === "sync") {
    const store = openStore(args);
    const usb = await listUsbIphones();
    const added = [];
    for (const d of usb.filter((x) => x.available)) {
      let row = store.state.devices.find((x) => x.udid === d.udid);
      if (!row) {
        row = {
          id: randomUUID(),
          name: d.name,
          udid: d.udid,
          online: true,
          createdAt: new Date().toISOString(),
        };
        store.state.devices.push(row);
        added.push(row);
      } else {
        row.online = true;
        row.name = d.name;
      }
    }
    // mark missing offline
    for (const row of store.state.devices) {
      if (!usb.some((u) => u.udid === row.udid && u.available)) {
        row.online = false;
      }
    }
    store.save();
    print({ ok: true, added, devices: store.state.devices, usb });
    return;
  }

  // ── Farm operations (real devices only) ────────────────
  if (cmd === "status") {
    const store = openStore(args);
    const driver = makeDriver();
    const orch = new FarmOrchestrator(store, driver);
    const time = getArg(args, "--time") ?? "09:00";
    const plan = orch.planSummary(time);
    let usb: unknown = [];
    try {
      usb = await listUsbIphones();
    } catch {
      /* ignore */
    }
    print({
      driver: "ios",
      simulator: false,
      devices: store.state.devices,
      usb,
      accounts: store.state.accounts,
      queue: store.state.queue,
      sessions: store.state.sessions.slice(-10),
      activity: store.state.activity.slice(-20),
      plan,
      locks: store.locks.snapshot(),
    });
    return;
  }

  if (cmd === "run" || cmd === "start-warmups") {
    const store = openStore(args);
    if (store.state.devices.length === 0) {
      console.error(
        JSON.stringify({
          error: "No devices registered. Run: heiss-farm devices sync && heiss-farm runner install",
        }),
      );
      process.exit(1);
    }
    if (store.state.accounts.length === 0) {
      console.error(
        JSON.stringify({
          error:
            "No accounts. Log into social apps on the iPhone, then: heiss-farm add-account <deviceId> tiktok @handle",
        }),
      );
      process.exit(1);
    }
    const offline = store.state.devices.filter((d) => !d.online);
    // refresh online from USB
    try {
      const usb = await listUsbIphones();
      for (const d of store.state.devices) {
        d.online = usb.some((u) => u.udid === d.udid && u.available);
      }
      store.save();
    } catch {
      /* proceed — driver will fail connect if missing */
    }

    const driver = makeDriver();
    const orch = new FarmOrchestrator(store, driver);
    const time = getArg(args, "--time") ?? "09:00";
    const interrupt = getArg(args, "--interrupt");
    const result = await orch.runOnce({
      runnerId: "local-farm",
      timeOfDay: time,
      interruptAfterSteps: interrupt ? Number(interrupt) : undefined,
    });
    print({
      ok: true,
      driver: "ios",
      simulator: false,
      interrupted: result.interrupted,
      sessions: result.sessions.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        kind: s.kind,
        status: s.status,
        stepIndex: s.checkpoint.stepIndex,
        posted: s.checkpoint.posted,
        activityLog: s.activityLog,
      })),
      activity: result.activity,
      queue: store.state.queue,
      accounts: store.state.accounts.map((a) => ({
        id: a.id,
        handle: a.handle,
        stage: a.stage,
        trustScore: a.trustScore,
      })),
    });
    return;
  }

  if (cmd === "resume") {
    const store = openStore(args);
    const driver = makeDriver();
    const orch = new FarmOrchestrator(store, driver);
    const time = getArg(args, "--time") ?? "09:00";
    const result = await orch.runOnce({
      runnerId: "local-farm",
      timeOfDay: time,
      resumeFirst: true,
    });
    if (store.state.sessions.some((s) => s.status === "checkpointed")) {
      const cont = await orch.runOnce({
        runnerId: "local-farm",
        timeOfDay: time,
      });
      print({ ok: true, resume: result, continue: cont, simulator: false });
      return;
    }
    print({ ok: true, ...result, simulator: false });
    return;
  }

  if (cmd === "register-device") {
    const store = openStore(args);
    const name = args[1];
    const udid = args[2];
    if (!name || !udid) {
      console.error("Usage: register-device <name> <udid>");
      process.exit(1);
    }
    // verify on USB
    const usb = await listUsbIphones();
    if (!usb.some((d) => d.udid === udid)) {
      console.error(
        JSON.stringify({
          error: `UDID ${udid} not on USB. heiss-farm devices list`,
        }),
      );
      process.exit(1);
    }
    const device = {
      id: randomUUID(),
      name,
      udid,
      online: true,
      createdAt: new Date().toISOString(),
    };
    store.state.devices.push(device);
    store.save();
    print({ ok: true, device });
    return;
  }

  if (cmd === "add-account") {
    const store = openStore(args);
    const deviceId = args[1];
    const platform = args[2] as Platform;
    const handle = args[3];
    if (!deviceId || !platform || !handle) {
      console.error(
        "Usage: add-account <deviceId> <tiktok|instagram|x|linkedin> <handle> [--stage fresh|matured]",
      );
      process.exit(1);
    }
    const device = store.state.devices.find(
      (d) => d.id === deviceId || d.udid === deviceId,
    );
    if (!device) {
      console.error(
        JSON.stringify({ error: "Unknown device. heiss-farm devices sync first." }),
      );
      process.exit(1);
    }
    assertCanAddAccount(store.state.accounts, device.id, platform);
    const stage = (getArg(args, "--stage") as AccountStage | undefined) ?? "fresh";
    const account = {
      id: randomUUID(),
      deviceId: device.id,
      platform,
      handle,
      stage,
      trustScore: stage === "fresh" ? 0 : 100,
      searchTerms: (getArg(args, "--terms") ?? "founders").split(","),
      createdAt: new Date().toISOString(),
    };
    store.state.accounts.push(account);
    // default morning slot for posting platforms
    if (platform === "tiktok" || platform === "instagram") {
      store.state.slots.push(createSlot(account.id, "09:00"));
    }
    store.save();
    print({
      ok: true,
      account,
      next:
        stage === "fresh"
          ? "heiss-farm start-warmups  # incubate before posting"
          : "heiss-farm drop … && heiss-farm run --time 09:00",
    });
    return;
  }

  if (cmd === "drop") {
    const store = openStore(args);
    const accounts = (getArg(args, "--accounts") ?? "").split(",").filter(Boolean);
    const caption = getArg(args, "--caption") ?? "";
    const media = getArg(args, "--media") ?? "media.bin";
    const music = getArg(args, "--music");
    const carousel = hasFlag(args, "--carousel");
    const { content, queueItem } = dropContent({
      kind: carousel ? "carousel" : "video",
      mediaRef: media,
      slides: carousel ? [media, `${media}-2`] : undefined,
      caption,
      music,
      accountIds: accounts,
      createdBy: "local-cli",
    });
    store.state.contents.push(content);
    store.state.queue.push(queueItem);
    store.save();
    print({ ok: true, content, queueItem });
    return;
  }

  if (cmd === "add-slot") {
    const store = openStore(args);
    const accountId = args[1];
    const time = args[2];
    if (!accountId || !time) {
      console.error("Usage: add-slot <accountId> <HH:mm>");
      process.exit(1);
    }
    const slot = createSlot(accountId, time);
    store.state.slots.push(slot);
    store.save();
    print({ ok: true, slot });
    return;
  }

  if (cmd === "setup" && args[1] === "all") {
    // Full guided setup: detect → install runner → register
    const team = getArg(args, "--team");
    const { device, install } = await setupDeviceAndRunner({
      udid: getArg(args, "--udid"),
      teamId: team,
    });
    const store = openStore(args);
    if (!store.state.devices.find((d) => d.udid === device.udid)) {
      store.state.devices.push({
        id: randomUUID(),
        name: device.name,
        udid: device.udid,
        online: true,
        createdAt: new Date().toISOString(),
      });
      store.save();
    }
    print({
      ok: true,
      device,
      install,
      humanNext: [
        "Trust developer certificate on the iPhone",
        "Open Heiss Runner app",
        "Log into TikTok/Instagram on the phone",
        "heiss-farm add-account <deviceId> tiktok @you",
        "heiss-farm start-warmups",
      ],
    });
    return;
  }

  if (cmd === "serve-api") {
    const { createServer } = await import("node:http");
    const port = Number(getArg(args, "--port") ?? 8787);
    const dataDir = getArg(args, "--data") ?? defaultDataDir();

    const server = createServer(async (req, res) => {
      const store = new JsonStore(farmStatePath(dataDir));
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const body = await readBody(req);
      const json = body ? safeJson(body) : null;
      try {
        if (url.pathname === "/health") {
          send(res, 200, { ok: true, service: "heiss-farm", simulator: false });
          return;
        }
        if (url.pathname === "/api/setup/status" && req.method === "GET") {
          const status = await getSetupStatus({
            hasRegisteredDevice: store.state.devices.length > 0,
            hasAccount: store.state.accounts.length > 0,
            hasWarmupSession: store.state.sessions.length > 0,
          });
          send(res, 200, status);
          return;
        }
        if (url.pathname === "/api/devices/usb" && req.method === "GET") {
          send(res, 200, { devices: await listUsbIphones() });
          return;
        }
        if (url.pathname === "/api/signup" && req.method === "POST") {
          const email = String(json?.email ?? "");
          const password = String(json?.password ?? "");
          if (store.state.users.some((u) => u.email === email.toLowerCase())) {
            send(res, 409, { error: "User exists" });
            return;
          }
          const user = createUser(email, password);
          store.state.users.push(user);
          store.save();
          send(res, 200, {
            ok: true,
            user: { id: user.id, email: user.email },
            token: issueSessionToken(user.id),
          });
          return;
        }
        if (url.pathname === "/api/login" && req.method === "POST") {
          const email = String(json?.email ?? "").toLowerCase();
          const password = String(json?.password ?? "");
          const user = store.state.users.find((u) => u.email === email);
          if (!user || !verifyPassword(password, user.passwordHash)) {
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
        if (url.pathname === "/api/accounts" && req.method === "GET") {
          send(res, 200, { accounts: store.state.accounts });
          return;
        }
        if (url.pathname === "/api/drop" && req.method === "POST") {
          const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
          const session = parseSessionToken(auth);
          const { content, queueItem } = dropContent({
            kind: (json?.kind as "video" | "carousel") ?? "video",
            mediaRef: String(json?.mediaRef ?? "upload.bin"),
            slides: json?.slides as string[] | undefined,
            caption: String(json?.caption ?? ""),
            music: json?.music ? String(json.music) : undefined,
            accountIds: (json?.accountIds as string[]) ?? [],
            createdBy: session?.userId ?? "anonymous",
          });
          store.state.contents.push(content);
          store.state.queue.push(queueItem);
          store.save();
          send(res, 200, {
            ok: true,
            content,
            queueItem,
            claimable: true,
            linkedAccountIds: queueItem.accountIds,
          });
          return;
        }
        if (url.pathname === "/api/overview" && req.method === "GET") {
          send(res, 200, {
            devices: store.state.devices,
            accounts: store.state.accounts,
            queue: store.state.queue,
            activity: store.state.activity.slice(-50),
            sessions: store.state.sessions.slice(-20),
            simulator: false,
          });
          return;
        }
        if (url.pathname === "/api/run" && req.method === "POST") {
          const driver = makeDriver();
          const orch = new FarmOrchestrator(store, driver);
          const time = String(json?.timeOfDay ?? "09:00");
          const result = await orch.runOnce({
            runnerId: "api-farm",
            timeOfDay: time,
          });
          send(res, 200, { ok: true, ...result, simulator: false });
          return;
        }
        send(res, 404, { error: "not found" });
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });

    server.listen(port, "127.0.0.1", () => {
      print({ ok: true, listening: `http://127.0.0.1:${port}`, dataDir, simulator: false });
    });
    return;
  }

  // Remove seed demo path that used fake devices — redirect
  if (cmd === "seed") {
    print({
      ok: false,
      error: "seed (simulator demo) removed. Use: heiss-farm setup all && add-account …",
      simulator: false,
    });
    process.exit(1);
  }

  console.error(usage());
  process.exit(1);
}

function send(
  res: import("node:http").ServerResponse,
  code: number,
  data: unknown,
): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
