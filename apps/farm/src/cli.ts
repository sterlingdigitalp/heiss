#!/usr/bin/env node
/**
 * heiss-farm — local controller (physical iPhones only, no simulator).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  JsonStore,
  FarmOrchestrator,
  dropContent,
  createUser,
  verifyPassword,
  issueSessionToken,
  parseSessionToken,
  assertCanAddAccount,
  assertWithinPlan,
  PLAN_TIERS,
  createSlot,
  createWarmupSchedule,
  warmupScheduleIsDue,
  nextWarmupSummary,
  localTimeOfDay,
  calendarDay,
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
import { findProjectRoot } from "./project-root.js";
import { createHmac, randomUUID } from "node:crypto";

function usage(): string {
  return `heiss-farm — Heiss local farm controller (real iPhones only)

Setup:
  heiss-farm setup status [--data DIR]
  heiss-farm setup device [--udid UDID] [--wait-ms N]
  heiss-farm runner install [--udid UDID] [--team TEAM_ID]
  heiss-farm signing show | set --team TEAM_ID | set --asc-key PATH --key-id ID --issuer ID
  heiss-farm devices list | sync [--data DIR]
  heiss-farm devices rename <deviceId> <name>
  heiss-farm license show | activate KEY [--url https://app.example]
  heiss-farm proxies list | add <name> <host> <port> [--user U] [--password P]
  heiss-farm proxies assign <proxyId> <deviceId>
  heiss-farm proxies unassign <deviceId> | remove <proxyId>
  heiss-farm cloud sync --url https://app.example [--license HEISS-…]
  heiss-farm cloud push [--license HEISS-…]

Farm:
  heiss-farm status [--data DIR]
  heiss-farm run [--time HH:mm] [--data DIR] [--interrupt N]
  heiss-farm daemon [--interval-sec 30] [--data DIR]
  heiss-farm resume [--data DIR]
  heiss-farm register-device <name> <udid>
  heiss-farm add-account <deviceId> <platform> <handle> [--stage STAGE] [--terms a,b]
  heiss-farm add-account-set <deviceId> <name> --instagram @h --tiktok @h --x @h --youtube @h [--terms "term,term"]
  heiss-farm account-set terms <groupId> "term,term"
  heiss-farm account handle <accountId> @handle
  heiss-farm remove-account <accountId>
  heiss-farm add-slot <accountId> <HH:mm>
  heiss-farm remove-slot <slotId>
  heiss-farm warmup-schedule list | set <accountId> <HH:mm> [--jitter N] | enable <accountId> | disable <accountId> | remove <accountId>
  heiss-farm settings show | timezone <IANA_ZONE> | caps <farm> <account>
  heiss-farm safety stop | resume
  heiss-farm data migrate --from DIR
  heiss-farm cancel <queueItemId>
  heiss-farm drop --accounts ID,ID --caption TEXT --media REF [--music M]
  heiss-farm drop --accounts ID,ID --caption TEXT --carousel --slides a.jpg,b.jpg
  heiss-farm start-warmups [--time HH:mm] [--data DIR]   # alias: run after setup
  heiss-farm serve-api [--port 8787]

Env:
  HEISS_DATA          Data directory (default ~/.heiss/live)
  HEISS_TEAM_ID       Xcode DEVELOPMENT_TEAM
  HEISS_ASC_KEY_PATH  App Store Connect .p8
  HEISS_ASC_KEY_ID    ASC key id
  HEISS_ASC_ISSUER_ID ASC issuer id
  HEISS_CLOUD_URL     Hosted Cloud Drop origin

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

function activePlan(store: JsonStore) {
  return PLAN_TIERS.find((p) => p.id === (store.state.license?.planId ?? "free")) ?? PLAN_TIERS[0]!;
}

function proxyImportUrl(proxy: { name: string; host: string; port: number; username?: string; password?: string }) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@`
    : "";
  return `socks5://${auth}${proxy.host}:${proxy.port}#${encodeURIComponent(proxy.name)}`;
}

function cloudCredentials(store: JsonStore, args: string[]) {
  const url = (getArg(args, "--url") ?? process.env.HEISS_CLOUD_URL ?? store.state.license?.cloudUrl ?? "").replace(/\/$/, "");
  const license = getArg(args, "--license") ?? store.state.license?.key ?? "";
  if (!url || !license) throw new Error("Cloud sync requires --url/HEISS_CLOUD_URL and an activated license");
  return { url, license };
}

async function cloudJson(url: string, license: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${license}` },
    body: JSON.stringify(body),
  });
  const json = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(String(json.error ?? `Cloud request failed (${response.status})`));
  return json;
}

async function syncCloudDrop(store: JsonStore, args: string[]) {
  const { url, license } = cloudCredentials(store, args);
  await cloudJson(url, license, "/api/runner/sync", {
    devices: store.state.devices,
    accounts: store.state.accounts,
    slots: store.state.slots,
  });
  const profileResponse = await cloudJson(url, license, "/api/runner/profiles", {});
  const expectedProfileSignature = createHmac("sha256", license)
    .update(JSON.stringify(profileResponse.profiles)).digest("hex");
  if (profileResponse.signature !== expectedProfileSignature) {
    throw new Error("Cloud UI profile signature is invalid");
  }
  store.state.uiProfiles = profileResponse.profiles ?? store.state.uiProfiles;
  store.save();
  const claimed = await cloudJson(url, license, "/api/runner/claim", { runnerId: "heiss-mac" });
  if (!claimed.item) return { ok: true, synced: true, claimed: null };
  const remoteItem = claimed.item as { id: string; createdAt: string };
  const remoteContent = claimed.content as { id: string; kind: "video"|"carousel"; mediaRef: string; slides?: string[]; mediaNames?: string[]; caption: string; music?: string; createdAt: string; createdBy: string };
  const targets = (claimed.targets as Array<{ sourceId?: string }>).map((target) => target.sourceId).filter((id): id is string => Boolean(id && store.state.accounts.some((a) => a.id === id)));
  if (targets.length === 0) throw new Error("Cloud Drop has no matching local accounts; sync account handles before claiming content");
  const refs = remoteContent.kind === "carousel" ? (remoteContent.slides ?? [remoteContent.mediaRef]) : [remoteContent.mediaRef];
  const names = remoteContent.mediaNames ?? [];
  const cloudDir = join(dirname(store.path), "cloud-drop"); mkdirSync(cloudDir, { recursive: true });
  const localRefs: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const response = await fetch(new URL(ref, url), { headers: { Authorization: `Bearer ${license}` } });
    if (!response.ok) throw new Error(`Cloud media download failed (${response.status})`);
    const safe = basename(names[index] ?? `media-${index}.bin`).replace(/[^a-zA-Z0-9._-]/g, "-");
    const localPath = join(cloudDir, `${remoteItem.id}-${index}-${safe}`);
    writeFileSync(localPath, Buffer.from(await response.arrayBuffer())); localRefs.push(localPath);
  }
  if (!store.state.contents.some((content) => content.id === remoteContent.id)) {
    store.state.contents.push({ ...remoteContent, mediaRef: localRefs[0]!, slides: remoteContent.kind === "carousel" ? localRefs : undefined });
  }
  if (!store.state.queue.some((item) => item.remoteQueueId === remoteItem.id)) {
    store.state.queue.push({
      id: randomUUID(), contentId: remoteContent.id, accountIds: targets, status: "queued",
      postedAccountIds: [], createdAt: remoteItem.createdAt, remoteUrl: url,
      remoteQueueId: remoteItem.id, remotePostedAccountIds: [],
    });
  }
  store.save();
  return { ok: true, synced: true, claimed: remoteItem.id, targets, media: localRefs };
}

async function pushCloudCompletions(store: JsonStore, licenseOverride?: string) {
  const license = licenseOverride ?? store.state.license?.key;
  if (!license) return { pushed: 0 };
  let pushed = 0;
  for (const item of store.state.queue.filter((q) => q.remoteUrl && q.remoteQueueId)) {
    const acknowledged = new Set(item.remotePostedAccountIds ?? []);
    for (const sourceAccountId of item.postedAccountIds ?? []) {
      if (acknowledged.has(sourceAccountId)) continue;
      await cloudJson(item.remoteUrl!, license, "/api/runner/complete", { queueId: item.remoteQueueId, sourceAccountId });
      acknowledged.add(sourceAccountId); pushed += 1;
    }
    item.remotePostedAccountIds = [...acknowledged];
  }
  if (pushed > 0) store.save();
  return { pushed };
}

/** Production driver only — real USB transport, never simulator. */
function makeDriver(): RealIosDriver {
  return new RealIosDriver(createProductionTransport());
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function notifyDesktop(title: string, body: string): void {
  if (process.platform !== "darwin" || process.env.HEISS_DISABLE_NOTIFICATIONS === "1") return;
  const safe = (value: string) => value.replace(/["\\]/g, " ").slice(0, 180);
  execFile("osascript", ["-e", `display notification "${safe(body)}" with title "${safe(title)}"`], () => undefined);
}

function parseSearchTerms(value: string | undefined, fallback = "founders"): string[] {
  const terms = (value ?? fallback).split(",").map((term) => term.trim()).filter(Boolean);
  return [...new Set(terms)];
}

interface RunnerInstallRecord {
  deviceName?: string;
  installedAt?: string;
  signingMethod?: "xcode" | "asc";
}

function runnerExpiryWarning(now: Date): { key: string; body: string } | null {
  const recordPath = join(homedir(), ".heiss", "runner-installs.json");
  if (!existsSync(recordPath)) return null;
  try {
    const records = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, RunnerInstallRecord>;
    const warnings = Object.entries(records).flatMap(([udid, record]) => {
      if (!record.installedAt) return [];
      const installedAt = new Date(record.installedAt);
      if (!Number.isFinite(installedAt.getTime())) return [];
      // Xcode personal-team provisioning is valid for about seven days. The
      // paid App Store Connect path is valid for about one year.
      const validityDays = record.signingMethod === "asc" ? 365 : 7;
      const expiresAt = new Date(installedAt.getTime() + validityDays * 86_400_000);
      const remainingMs = expiresAt.getTime() - now.getTime();
      if (remainingMs > 48 * 3_600_000) return [];
      return [{ udid, name: record.deviceName ?? udid, expiresAt, remainingMs }];
    }).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    const warning = warnings[0];
    if (!warning) return null;
    const date = warning.expiresAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return {
      key: `${warning.udid}:${warning.expiresAt.toISOString()}`,
      body: warning.remainingMs <= 0
        ? `${warning.name}'s HeissRunner signing has expired. Reinstall the runner before the next session.`
        : `${warning.name}'s HeissRunner signing expires ${date}. Reinstall it before then.`,
    };
  } catch {
    return null;
  }
}

function rebalanceWarmupSchedules(store: JsonStore): void {
  if (store.state.warmupSchedules.length > 16) {
    throw new Error("One iPhone supports at most 16 scheduled handles in the four-platform account-set layout");
  }
  for (const [index, schedule] of store.state.warmupSchedules.entries()) {
    const minutes = 20 * 60 + index * 15;
    schedule.timeOfDay = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    process.exit(0);
  }

  if (cmd === "data" && args[1] === "migrate") {
    const from = getArg(args, "--from");
    if (!from) throw new Error("Usage: data migrate --from DIR [--data DIR]");
    const source = farmStatePath(resolve(from));
    const target = farmStatePath(getArg(args, "--data") ?? defaultDataDir());
    if (!existsSync(source)) throw new Error(`Source farm state does not exist: ${source}`);
    if (existsSync(target) && !hasFlag(args, "--replace")) throw new Error(`Target already exists: ${target}; use --replace only after backing it up`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    const store = new JsonStore(target);
    store.save();
    print({ ok: true, source, target, accounts: store.state.accounts.length, devices: store.state.devices.length });
    return;
  }

  if (cmd === "settings" && args[1] === "show") {
    const store = openStore(args); print({ ok: true, settings: store.state.settings }); return;
  }

  if (cmd === "settings" && args[1] === "timezone") {
    const zone = args[2];
    if (!zone) throw new Error("Usage: settings timezone <IANA_ZONE>");
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(); } catch { throw new Error(`Invalid IANA timezone: ${zone}`); }
    const store = openStore(args); store.state.settings.timeZone = zone; store.save(); print({ ok: true, settings: store.state.settings }); return;
  }

  if (cmd === "settings" && args[1] === "caps") {
    const farmCap = Number(args[2]), accountCap = Number(args[3]);
    if (!Number.isInteger(farmCap) || !Number.isInteger(accountCap) || farmCap < 1 || accountCap < 1 || accountCap > farmCap) {
      throw new Error("Usage: settings caps <farm-positive-int> <account-positive-int>");
    }
    const store = openStore(args); store.state.settings.dailyActionCap = farmCap; store.state.settings.accountDailyActionCap = accountCap;
    store.save(); print({ ok: true, settings: store.state.settings }); return;
  }

  if (cmd === "safety" && (args[1] === "stop" || args[1] === "resume")) {
    const store = openStore(args); store.state.settings.emergencyStop = args[1] === "stop";
    store.pushActivity({ kind: "safety", message: store.state.settings.emergencyStop ? "Emergency stop engaged" : "Emergency stop cleared" });
    store.save(); print({ ok: true, emergencyStop: store.state.settings.emergencyStop }); return;
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
    const repoRoot = findProjectRoot();
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
    assertWithinPlan(activePlan(store), store.state.devices.length, store.state.accounts.length);
    store.save();
    print({ ok: true, added, devices: store.state.devices, usb });
    return;
  }

  if (cmd === "devices" && args[1] === "rename") {
    const store = openStore(args);
    const device = store.state.devices.find((row) => row.id === args[2] || row.udid === args[2]);
    const name = args.slice(3).join(" ").trim();
    if (!device || !name) throw new Error("Usage: devices rename <deviceId> <name>");
    device.name = name; store.save(); print({ ok: true, device }); return;
  }

  if (cmd === "license" && args[1] === "show") {
    const store = openStore(args);
    print({ ok: true, activation: store.state.license ?? null, plan: activePlan(store) });
    return;
  }

  if (cmd === "license" && args[1] === "activate") {
    const store = openStore(args);
    const key = args[2]?.trim();
    if (!key || !/^HEISS-[A-Z0-9-]{8,}$/i.test(key)) {
      throw new Error("Usage: license activate HEISS-… [--url https://app.example]");
    }
    const cloudUrl = (getArg(args, "--url") ?? process.env.HEISS_CLOUD_URL ?? "").replace(/\/$/, "");
    let plan = PLAN_TIERS[0]!;
    if (cloudUrl) {
      const remote = await cloudJson(cloudUrl, key, "/api/runner/license", {});
      plan = remote.plan;
    }
    assertWithinPlan(plan, store.state.devices.length, store.state.accounts.length);
    store.state.license = { key, planId: plan.id, activatedAt: new Date().toISOString(), cloudUrl: cloudUrl || undefined };
    store.save();
    print({ ok: true, activation: store.state.license, plan });
    return;
  }

  if (cmd === "proxies" && args[1] === "list") {
    const store = openStore(args);
    print({ ok: true, proxies: store.state.proxies.map((proxy) => ({ ...proxy, importUrl: proxyImportUrl(proxy) })) });
    return;
  }

  if (cmd === "proxies" && args[1] === "add") {
    const store = openStore(args);
    const name = args[2], host = args[3], port = Number(args[4]);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Usage: proxies add <name> <host> <port> [--user U] [--password P]");
    }
    const proxy = { id: randomUUID(), name, type: "socks5" as const, host, port, username: getArg(args, "--user"), password: getArg(args, "--password"), createdAt: new Date().toISOString() };
    store.state.proxies.push(proxy); store.save(); print({ ok: true, proxy: { ...proxy, importUrl: proxyImportUrl(proxy) } }); return;
  }

  if (cmd === "proxies" && args[1] === "assign") {
    const store = openStore(args);
    const proxy = store.state.proxies.find((p) => p.id === args[2]);
    const device = store.state.devices.find((d) => d.id === args[3] || d.udid === args[3]);
    if (!proxy || !device) throw new Error("Unknown proxy or device");
    if (store.state.proxies.some((p) => p.deviceId === device.id && p.id !== proxy.id)) {
      throw new Error("Device already has a different proxy assigned");
    }
    if (proxy.deviceId && proxy.deviceId !== device.id) throw new Error("Proxy already belongs to another device");
    proxy.deviceId = device.id; device.proxyId = proxy.id; store.save(); print({ ok: true, proxy: { ...proxy, importUrl: proxyImportUrl(proxy) }, device }); return;
  }

  if (cmd === "proxies" && args[1] === "unassign") {
    const store = openStore(args);
    const device = store.state.devices.find((row) => row.id === args[2] || row.udid === args[2]);
    if (!device) throw new Error("Unknown device");
    const proxy = store.state.proxies.find((row) => row.id === device.proxyId || row.deviceId === device.id);
    if (proxy) proxy.deviceId = undefined; device.proxyId = undefined;
    store.save(); print({ ok: true, device, proxy: proxy ?? null }); return;
  }

  if (cmd === "proxies" && args[1] === "remove") {
    const store = openStore(args);
    const index = store.state.proxies.findIndex((row) => row.id === args[2]);
    if (index < 0) throw new Error("Unknown proxy");
    if (store.state.proxies[index]!.deviceId) throw new Error("Unassign the proxy before removing it");
    const [proxy] = store.state.proxies.splice(index, 1); store.save(); print({ ok: true, proxy }); return;
  }

  if (cmd === "cloud" && args[1] === "sync") {
    const store = openStore(args);
    print(await syncCloudDrop(store, args));
    return;
  }

  if (cmd === "cloud" && args[1] === "push") {
    const store = openStore(args);
    print({ ok: true, ...(await pushCloudCompletions(store, getArg(args, "--license"))) });
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
      accountGroups: store.state.accountGroups,
      queue: store.state.queue,
      contents: store.state.contents,
      slots: store.state.slots,
      warmupSchedules: store.state.warmupSchedules,
      settings: store.state.settings,
      nextWarmups: nextWarmupSummary(
        store.state.warmupSchedules,
        store.state.accounts,
        new Date().toISOString(),
        store.state.settings.timeZone,
      ),
      proxies: store.state.proxies.map((proxy) => ({ ...proxy, importUrl: proxyImportUrl(proxy) })),
      license: store.state.license ?? null,
      activePlan: activePlan(store),
      sessions: store.state.sessions.slice(-10),
      activity: store.state.activity.slice(-20),
      plan,
      locks: store.locks.snapshot(),
    });
    return;
  }

  if (cmd === "daemon") {
    const intervalMs = Math.max(5_000, Number(getArg(args, "--interval-sec") ?? 30) * 1000);
    let stopping = false;
    process.once("SIGINT", () => { stopping = true; });
    process.once("SIGTERM", () => { stopping = true; });
    print({ ok: true, daemon: "started", intervalMs, pid: process.pid });
    while (!stopping) {
      const store = openStore(args);
      const now = new Date();
      const nowIso = now.toISOString();
      const timeOfDay = localTimeOfDay(nowIso, store.state.settings.timeZone);
      try {
        const expiry = runnerExpiryWarning(now);
        if (expiry && store.state.settings.notificationKeys.runnerExpiry !== expiry.key) {
          notifyDesktop("HeissRunner signing expires soon", expiry.body);
          store.state.settings.notificationKeys.runnerExpiry = expiry.key;
        }
        if ((process.env.HEISS_CLOUD_URL || store.state.license?.cloudUrl) && store.state.license?.key) {
          await syncCloudDrop(store, args);
        }
        const usb = await listUsbIphones().catch(() => []);
        const transitions: Array<{ name: string; online: boolean }> = [];
        for (const device of store.state.devices) {
          const online = usb.some((candidate) => candidate.udid === device.udid && candidate.available);
          const previous = store.state.settings.deviceStates[device.id];
          device.online = online;
          store.state.settings.deviceStates[device.id] = online ? "online" : "offline";
          if (previous && previous !== store.state.settings.deviceStates[device.id]) transitions.push({ name: device.name, online });
        }
        store.save();
        for (const transition of transitions) {
          notifyDesktop(transition.online ? "Heiss iPhone reconnected" : "Heiss iPhone disconnected", `${transition.name} is ${transition.online ? "ready" : "offline"}.`);
        }
        if (store.state.devices.some((device) => device.online) && store.state.accounts.length > 0) {
          const posting = await new FarmOrchestrator(store, makeDriver()).runOnce({
            runnerId: `daemon-${process.pid}`,
            timeOfDay,
            now: nowIso,
            skipWarmups: true,
          });
          const dueWarmupIds = store.state.warmupSchedules.filter((schedule) => {
            const account = store.state.accounts.find((candidate) => candidate.id === schedule.accountId);
            return account && warmupScheduleIsDue(schedule, nowIso, store.state.settings.timeZone, account.lastWarmupAt);
          }).map((schedule) => schedule.accountId);
          const warmups = dueWarmupIds.length > 0
            ? await new FarmOrchestrator(store, makeDriver()).runOnce({
                runnerId: `daemon-${process.pid}`,
                timeOfDay,
                now: nowIso,
                warmupAccountIds: dueWarmupIds,
              })
            : { sessions: [], activity: [], interrupted: false };
          const result = { sessions: [...posting.sessions, ...warmups.sessions], interrupted: posting.interrupted || warmups.interrupted };
          const cloud = await pushCloudCompletions(store).catch((error) => ({ warning: String(error), pushed: 0 }));
          const completed = result.sessions.filter((session) => session.status === "completed").length;
          if (completed > 0) notifyDesktop("Heiss session complete", `${completed} scheduled session${completed === 1 ? "" : "s"} completed.`);
          if (result.interrupted) notifyDesktop("Heiss needs attention", "A session paused safely and will retry after its backoff window.");
          console.log(JSON.stringify({
            at: nowIso, timeOfDay, timeZone: store.state.settings.timeZone,
            sessions: result.sessions.length,
            posts: result.sessions.filter((session) => session.kind === "post" && session.checkpoint.posted).length,
            completed, interrupted: result.interrupted, dueWarmupIds, cloud,
          }));
        } else {
          console.log(JSON.stringify({ at: nowIso, timeOfDay, waiting: "Connect an online iPhone and add an account" }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyDesktop("Heiss controller error", message);
        console.error(JSON.stringify({ at: nowIso, error: message }));
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, 60_000)));
    }
    print({ ok: true, daemon: "stopped" });
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
    const cloudPull = (process.env.HEISS_CLOUD_URL || store.state.license?.cloudUrl) && store.state.license?.key
      ? await syncCloudDrop(store, args).catch((error) => ({
          ok: false,
          warning: error instanceof Error ? error.message : String(error),
        }))
      : { ok: true, skipped: true };
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
      accountId: getArg(args, "--account"),
      interruptAfterSteps: interrupt ? Number(interrupt) : undefined,
    });
    const cloud = await pushCloudCompletions(store).catch((error) => ({
      pushed: 0,
      warning: error instanceof Error ? error.message : String(error),
    }));
    print({
      ok: true,
      driver: "ios",
      simulator: false,
      interrupted: result.interrupted,
      cloudPull,
      cloud,
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
    const sessionId = getArg(args, "--session");
    const result = await orch.runOnce({
      runnerId: "local-farm",
      timeOfDay: time,
      resumeFirst: true,
      sessionId,
    });
    if (sessionId) {
      print({ ok: true, ...result, simulator: false });
      return;
    }
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
    assertWithinPlan(activePlan(store), store.state.devices.length, store.state.accounts.length);
    store.save();
    print({ ok: true, device });
    return;
  }

  if (cmd === "account" && args[1] === "handle") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    const handle = args[3]?.trim();
    if (!account || !handle || !/^@[A-Za-z0-9._-]+$/.test(handle)) {
      throw new Error("Usage: account handle <accountId> @handle");
    }
    account.handle = handle;
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "account-set" && args[1] === "terms") {
    const store = openStore(args);
    const group = store.state.accountGroups.find((candidate) => candidate.id === args[2]);
    const terms = parseSearchTerms(args[3], "");
    if (!group || terms.length === 0) throw new Error("Usage: account-set terms <groupId> \"term,term\"");
    const accounts = store.state.accounts.filter((account) => account.groupId === group.id);
    if (accounts.length === 0) throw new Error(`Account set ${group.name} has no linked accounts`);
    for (const account of accounts) account.searchTerms = terms;
    store.save(); print({ ok: true, group, terms, accounts: accounts.map((account) => account.id) }); return;
  }

  if (cmd === "add-account-set") {
    const store = openStore(args);
    const deviceId = args[1];
    const name = args[2]?.trim();
    const device = store.state.devices.find((candidate) => candidate.id === deviceId || candidate.udid === deviceId);
    const platforms = ["instagram", "tiktok", "x", "youtube"] as const;
    const handles = Object.fromEntries(platforms.map((platform) => [platform, getArg(args, `--${platform}`)?.trim()]));
    if (!device || !name || platforms.some((platform) => !handles[platform])) {
      throw new Error("Usage: add-account-set <deviceId> <name> --instagram @h --tiktok @h --x @h --youtube @h [--terms \"term,term\"]");
    }
    const proposed = [...store.state.accounts];
    for (const platform of platforms) {
      assertCanAddAccount(proposed, device.id, platform);
      proposed.push({
        id: `pending-${platform}`, deviceId: device.id, platform, handle: handles[platform]!, stage: "fresh",
        trustScore: 0, searchTerms: [], createdAt: new Date().toISOString(),
      });
    }
    assertWithinPlan(activePlan(store), store.state.devices.length, proposed.length);
    const group = { id: randomUUID(), name, deviceId: device.id, createdAt: new Date().toISOString() };
    const created = platforms.map((platform) => ({
      id: randomUUID(), groupId: group.id, deviceId: device.id, platform, handle: handles[platform]!,
      stage: "fresh" as const, trustScore: 0, warmupLocalDays: [],
      searchTerms: parseSearchTerms(getArg(args, "--terms")), createdAt: new Date().toISOString(),
    }));
    store.state.accountGroups.push(group);
    for (const account of created) {
      store.state.accounts.push(account);
      if (account.platform === "tiktok" || account.platform === "instagram") store.state.slots.push(createSlot(account.id, "09:00"));
      const index = store.state.warmupSchedules.length;
      const minutes = 20 * 60 + 30 + index * 20;
      const time = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      store.state.warmupSchedules.push(createWarmupSchedule(account.id, time, 8));
    }
    rebalanceWarmupSchedules(store);
    store.save(); print({ ok: true, group, accounts: created }); return;
  }

  if (cmd === "add-account") {
    const store = openStore(args);
    const deviceId = args[1];
    const platform = args[2] as Platform;
    const handle = args[3];
    if (!deviceId || !platform || !handle) {
      console.error(
        "Usage: add-account <deviceId> <tiktok|instagram|x|youtube> <handle> [--stage fresh|matured]",
      );
      process.exit(1);
    }
    if (!["tiktok", "instagram", "x", "youtube"].includes(platform)) {
      throw new Error(`Unsupported platform ${platform}; expected tiktok, instagram, x, or youtube`);
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
      searchTerms: parseSearchTerms(getArg(args, "--terms")),
      createdAt: new Date().toISOString(),
    };
    store.state.accounts.push(account);
    assertWithinPlan(activePlan(store), store.state.devices.length, store.state.accounts.length);
    // default morning slot for posting platforms
    if (platform === "tiktok" || platform === "instagram") {
      store.state.slots.push(createSlot(account.id, "09:00"));
    }
    const warmupIndex = store.state.warmupSchedules.length;
    const minutes = 20 * 60 + 30 + warmupIndex * 20;
    const warmupTime = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    store.state.warmupSchedules.push(createWarmupSchedule(account.id, warmupTime, 8));
    if (store.state.warmupSchedules.length > 4) rebalanceWarmupSchedules(store);
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

  if (cmd === "remove-account") {
    const store = openStore(args);
    const index = store.state.accounts.findIndex((account) => account.id === args[1]);
    if (index < 0) throw new Error("Unknown account");
    const account = store.state.accounts[index]!;
    if (store.state.sessions.some((session) => session.accountId === account.id && ["running", "checkpointed"].includes(session.status))) {
      throw new Error("Account has an active or recoverable session; finish or resolve it before removal");
    }
    store.state.accounts.splice(index, 1);
    store.state.slots = store.state.slots.filter((slot) => slot.accountId !== account.id);
    store.state.warmupSchedules = store.state.warmupSchedules.filter((slot) => slot.accountId !== account.id);
    for (const item of store.state.queue.filter((queue) => queue.accountIds.includes(account.id))) {
      item.accountIds = item.accountIds.filter((id) => id !== account.id);
      if (item.accountIds.length === 0 && item.status !== "posted") item.status = "cancelled";
    }
    if (account.groupId && !store.state.accounts.some((candidate) => candidate.groupId === account.groupId)) {
      store.state.accountGroups = store.state.accountGroups.filter((group) => group.id !== account.groupId);
    }
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "drop") {
    const store = openStore(args);
    const accounts = (getArg(args, "--accounts") ?? "").split(",").filter(Boolean);
    const caption = getArg(args, "--caption") ?? "";
    const media = getArg(args, "--media") ?? "media.bin";
    const music = getArg(args, "--music");
    const carousel = hasFlag(args, "--carousel");
    const slides = (getArg(args, "--slides") ?? "").split(",").filter(Boolean);
    if (carousel && slides.length < 2) throw new Error("Carousel drop requires --slides first.jpg,second.jpg");
    const { content, queueItem } = dropContent({
      kind: carousel ? "carousel" : "video",
      mediaRef: carousel ? slides[0]! : media,
      slides: carousel ? slides : undefined,
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

  if (cmd === "warmup-schedule" && args[1] === "list") {
    const store = openStore(args);
    print({
      ok: true,
      timeZone: store.state.settings.timeZone,
      schedules: store.state.warmupSchedules,
      next: nextWarmupSummary(store.state.warmupSchedules, store.state.accounts, new Date().toISOString(), store.state.settings.timeZone),
    });
    return;
  }

  if (cmd === "warmup-schedule" && args[1] === "set") {
    const store = openStore(args);
    const accountId = args[2], time = args[3];
    const account = store.state.accounts.find((candidate) => candidate.id === accountId);
    if (!account || !time) throw new Error("Usage: warmup-schedule set <accountId> <HH:mm> [--jitter N]");
    const jitter = Number(getArg(args, "--jitter") ?? 8);
    store.state.warmupSchedules = store.state.warmupSchedules.filter((schedule) => schedule.accountId !== accountId);
    const schedule = createWarmupSchedule(account.id, time, jitter);
    store.state.warmupSchedules.push(schedule);
    store.save(); print({ ok: true, account, schedule }); return;
  }

  if (cmd === "warmup-schedule" && args[1] === "remove") {
    const store = openStore(args); const accountId = args[2];
    const removed = store.state.warmupSchedules.filter((schedule) => schedule.accountId === accountId);
    store.state.warmupSchedules = store.state.warmupSchedules.filter((schedule) => schedule.accountId !== accountId);
    store.save(); print({ ok: true, removed }); return;
  }

  if (cmd === "warmup-schedule" && (args[1] === "enable" || args[1] === "disable")) {
    const store = openStore(args); const accountId = args[2];
    const schedule = store.state.warmupSchedules.find((candidate) => candidate.accountId === accountId);
    if (!schedule) throw new Error(`No warmup schedule for account ${accountId ?? ""}`.trim());
    schedule.enabled = args[1] === "enable";
    store.save(); print({ ok: true, schedule }); return;
  }

  if (cmd === "remove-slot") {
    const store = openStore(args);
    const index = store.state.slots.findIndex((slot) => slot.id === args[1]);
    if (index < 0) throw new Error("Unknown slot");
    const [slot] = store.state.slots.splice(index, 1); store.save(); print({ ok: true, slot }); return;
  }

  if (cmd === "cancel") {
    const store = openStore(args);
    const item = store.state.queue.find((queue) => queue.id === args[1]);
    if (!item) throw new Error("Unknown queue item");
    if (["posted", "assigned"].includes(item.status)) throw new Error(`Cannot cancel content in ${item.status} status`);
    item.status = "cancelled"; store.save(); print({ ok: true, item }); return;
  }

  if (cmd === "setup" && args[1] === "all") {
    // Full guided setup: detect → install runner → register
    const team = getArg(args, "--team");
    const { device, install } = await setupDeviceAndRunner({
      udid: getArg(args, "--udid"),
      teamId: team,
      repoRoot: findProjectRoot(),
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
