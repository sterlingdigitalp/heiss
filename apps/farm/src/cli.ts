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
  assessDeviceCapacity,
  defaultEngagementPolicy,
  engagementAutonomousEligible,
  ensureDailyEngagementApproval,
  normalizeEngagementPolicy,
  checkpointStaleRunningSessions,
  approveCandidate,
  refreshCandidateQueue,
  recordDiscoveryCandidates,
  normalizePlatformCandidateHandle,
  isAmbiguousCandidateHandle,
  candidateTargetKey,
} from "@heiss/core";
import {
  RealIosDriver,
  createProductionTransport,
  listUsbIphones,
  pollUntilReady,
  getSetupStatus,
  setupDeviceAndRunner,
  downloadBuildInstallRunner,
  checkAutomationRunner,
  ensureAutomationRunner,
  superviseDeviceHealth,
  stopAutomationRunner,
  planSigning,
  saveSigningConfig,
  resolveSigningConfig,
  detectLocalTeams,
} from "@heiss/device";
import { defaultDataDir, farmStatePath } from "./paths.js";
import { findProjectRoot } from "./project-root.js";
import {
  controllerAgentStatus,
  installControllerAgent,
  uninstallControllerAgent,
} from "./daemon-agent.js";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AUTHORIZED_MUTATION_ENV,
  SerialCommandAuthority,
  commandMutatesFarm,
  forwardToController,
  startCommandAuthorityServer,
} from "./command-authority.js";

function usage(): string {
  return `heiss-farm — Heiss local farm controller (real iPhones only)

Setup:
  heiss-farm setup status [--data DIR]
  heiss-farm setup device [--udid UDID] [--wait-ms N]
  heiss-farm runner install [--udid UDID] [--team TEAM_ID]
  heiss-farm runner status | ensure | stop | clear-cache [--udid UDID]
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
  heiss-farm daemon install | uninstall | status [--data DIR]   # persistent launchd agent
  heiss-farm resume [--data DIR]
  heiss-farm register-device <name> <udid>
  heiss-farm add-account <deviceId> <platform> <handle> [--stage STAGE] [--terms a,b]
  heiss-farm add-account-set <deviceId> <name> --instagram @h --tiktok @h --x @h --youtube @h [--terms "term,term"]
  heiss-farm account-set terms <groupId> "term,term"
  heiss-farm account-set rename <groupId> <name>
  heiss-farm account handle <accountId> @handle
  heiss-farm account switcher <accountId> "picker label"
  heiss-farm account identity <accountId> [--display-name NAME] [--email EMAIL] [--switcher LABEL] [--avatar HASH]
  heiss-farm account preflight <accountId> <pending|ready|attention> [--app-version VERSION] [--note NOTE]
  heiss-farm preflight canary [--accounts ID,ID] [--low-trust-first] [--ring] [--lowest N]
  heiss-farm preflight verify-all
  heiss-farm preflight x-composer <accountId>
  heiss-farm preflight health [--udid UDID]
  heiss-farm remove-account <accountId>
  heiss-farm add-slot <accountId> <HH:mm>
  heiss-farm remove-slot <slotId>
  heiss-farm warmup-schedule list | rebalance | set <accountId> <HH:mm> [--jitter N] | enable <accountId> | disable <accountId> | remove <accountId>
  heiss-farm settings show | timezone <IANA_ZONE> | caps <farm> <account>
  heiss-farm engagement show
  heiss-farm engagement configure <accountId> --mode off|review|autonomous [--likes on|off] [--follows on|off] [--like-cap 0..5] [--follow-cap 0..2] [--cooldown-min N]
  heiss-farm engagement review <accountId>
  heiss-farm engagement approve|reject <approvalId>
  heiss-farm candidates show [--group GROUP_ID]
  heiss-farm candidates canary <accountId>
  heiss-farm candidates approve <candidateId> <like|follow>
  heiss-farm candidates reject <candidateId>
  heiss-farm candidates assist <approvalId> | complete <approvalId> | skip <approvalId>
  heiss-farm safety stop | resume
  heiss-farm maintenance enter [--reason TEXT] | exit | status
  heiss-farm data migrate --from DIR
  heiss-farm cancel <queueItemId>
  heiss-farm drop --accounts ID,ID --caption TEXT --text
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

function parseOnOff(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`Expected on or off, got ${value}`);
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
  const remoteContent = claimed.content as { id: string; kind: "text"|"video"|"carousel"; mediaRef: string; slides?: string[]; mediaNames?: string[]; caption: string; music?: string; createdAt: string; createdBy: string };
  const targets = (claimed.targets as Array<{ sourceId?: string }>).map((target) => target.sourceId).filter((id): id is string => Boolean(id && store.state.accounts.some((a) => a.id === id)));
  if (targets.length === 0) throw new Error("Cloud Drop has no matching local accounts; sync account handles before claiming content");
  const refs = remoteContent.kind === "text" ? [] : remoteContent.kind === "carousel" ? (remoteContent.slides ?? [remoteContent.mediaRef]) : [remoteContent.mediaRef];
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
    store.state.contents.push({ ...remoteContent, mediaRef: remoteContent.kind === "text" ? "" : localRefs[0]!, slides: remoteContent.kind === "carousel" ? localRefs : undefined });
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
  return new RealIosDriver(createProductionTransport({
    onProgress(progress) {
      console.log(JSON.stringify({ at: new Date().toISOString(), sessionProgress: progress }));
    },
  }));
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

/** Signed-runner installs with their provisioning expiry. */
function runnerInstallExpiries(now: Date): Array<{ udid: string; name: string; expiresAt: Date; remainingMs: number }> {
  const recordPath = join(homedir(), ".heiss", "runner-installs.json");
  if (!existsSync(recordPath)) return [];
  try {
    const records = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, RunnerInstallRecord>;
    return Object.entries(records).flatMap(([udid, record]) => {
      if (!record.installedAt) return [];
      const installedAt = new Date(record.installedAt);
      if (!Number.isFinite(installedAt.getTime())) return [];
      // Xcode personal-team provisioning is valid for about seven days. The
      // paid App Store Connect path is valid for about one year.
      const validityDays = record.signingMethod === "asc" ? 365 : 7;
      const expiresAt = new Date(installedAt.getTime() + validityDays * 86_400_000);
      return [{ udid, name: record.deviceName ?? udid, expiresAt, remainingMs: expiresAt.getTime() - now.getTime() }];
    }).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  } catch {
    return [];
  }
}

/** Installs the daemon should proactively re-sign (within 24h of expiry). */
function runnersNeedingReinstall(now: Date): Array<{ udid: string; name: string; expiresAt: Date }> {
  return runnerInstallExpiries(now).filter((entry) => entry.remainingMs <= 24 * 3_600_000);
}

function runnerExpiryWarning(now: Date): { key: string; body: string } | null {
  try {
    const warnings = runnerInstallExpiries(now).filter((entry) => entry.remainingMs <= 48 * 3_600_000);
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
  const order = store.state.settings.platformOrder;
  const accountById = new Map(store.state.accounts.map((account) => [account.id, account]));
  const deviceRank = new Map(store.state.devices.map((device, index) => [device.id, index]));
  store.state.warmupSchedules.sort((left, right) => {
    const leftAccount = accountById.get(left.accountId);
    const rightAccount = accountById.get(right.accountId);
    const deviceDifference = (deviceRank.get(leftAccount?.deviceId ?? "") ?? Number.MAX_SAFE_INTEGER)
      - (deviceRank.get(rightAccount?.deviceId ?? "") ?? Number.MAX_SAFE_INTEGER);
    const leftRank = leftAccount ? order.indexOf(leftAccount.platform) : order.length;
    const rightRank = rightAccount ? order.indexOf(rightAccount.platform) : order.length;
    return deviceDifference
      || (leftRank < 0 ? order.length : leftRank) - (rightRank < 0 ? order.length : rightRank)
      || (leftAccount?.groupId ?? "").localeCompare(rightAccount?.groupId ?? "")
      || left.accountId.localeCompare(right.accountId);
  });
  const deviceScheduleIndexes = new Map<string, number>();
  for (const schedule of store.state.warmupSchedules) {
    const deviceId = accountById.get(schedule.accountId)?.deviceId ?? "unassigned";
    const index = deviceScheduleIndexes.get(deviceId) ?? 0;
    deviceScheduleIndexes.set(deviceId, index + 1);
    const minutes = 15 * 60 + 30 + index * 14;
    schedule.timeOfDay = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    schedule.jitterMinutes = Math.min(schedule.jitterMinutes, 5);
  }
  store.state.settings.platformScheduleVersion = 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    process.exit(0);
  }

  // The persistent controller is the sole mutation authority. Desktop and
  // ad-hoc CLI writes are forwarded to its serialized command queue.
  if (commandMutatesFarm(args) && process.env[AUTHORIZED_MUTATION_ENV] !== "1") {
    const dataDir = getArg(args, "--data") ?? defaultDataDir();
    const forwarded = await forwardToController(dataDir, args);
    if (forwarded.forwarded) {
      if (forwarded.stdout) process.stdout.write(forwarded.stdout);
      if (forwarded.stderr) process.stderr.write(forwarded.stderr);
      if ((forwarded.code ?? 0) !== 0) process.exitCode = forwarded.code;
      return;
    }
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

  if (cmd === "maintenance" && ["enter", "exit", "status"].includes(args[1] ?? "")) {
    const store = openStore(args);
    if (args[1] === "status") {
      const running = store.state.sessions.filter((session) => session.status === "running");
      print({ ok: true, maintenance: store.state.settings.maintenance, runningSessions: running.map((session) => session.id) });
      return;
    }
    if (args[1] === "enter") {
      const running = store.state.sessions.filter((session) => session.status === "running");
      store.state.settings.maintenance = {
        mode: running.length > 0 ? "draining" : "active",
        reason: getArg(args, "--reason") ?? "Operator maintenance",
        requestedAt: new Date().toISOString(),
        enteredAt: running.length === 0 ? new Date().toISOString() : undefined,
        requestedBy: `cli-${process.pid}`,
      };
      store.pushActivity({ kind: "maintenance", message: running.length > 0 ? "Maintenance requested; draining current checkpoint" : "Maintenance mode entered" });
    } else {
      store.state.settings.maintenance = { mode: "running" };
      store.pushActivity({ kind: "maintenance", message: "Maintenance mode exited; autonomous controller resumed" });
    }
    store.save();
    print({ ok: true, maintenance: store.state.settings.maintenance });
    return;
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

  if (cmd === "runner" && args[1] === "clear-cache") {
    const requested = getArg(args, "--udid");
    const usb = await listUsbIphones();
    const udid = requested ?? usb.find((d) => d.available)?.udid;
    if (!udid) throw new Error("No USB iPhone available; connect one or pass --udid");
    const driver = makeDriver();
    await driver.connect(`clear-cache`, udid);
    const r = await driver.runAction(`clear-cache`, "manual", "tiktok:clear_cache", { platform: "tiktok", handle: "" });
    await driver.disconnect(`clear-cache`).catch(() => undefined);
    print({ ok: true, udid, result: r.detail });
    return;
  }

  if (cmd === "runner" && ["status", "ensure", "stop"].includes(args[1] ?? "")) {
    const requested = getArg(args, "--udid");
    const udid = requested ?? (await listUsbIphones()).find((d) => d.available)?.udid;
    if (!udid) throw new Error("No USB iPhone available; connect one or pass --udid");
    if (args[1] === "status") {
      print({ ok: true, health: await checkAutomationRunner(udid) });
      return;
    }
    if (args[1] === "stop") {
      await stopAutomationRunner(udid);
      print({ ok: true, stopped: udid });
      return;
    }
    const repair = await ensureAutomationRunner(udid, { repoRoot: findProjectRoot() });
    print({ udid, ...repair });
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
          model: d.model,
          viewportClass: /\bSE\b|mini/i.test(`${d.model ?? ""} ${d.name}`) ? "compact" : "regular",
          createdAt: new Date().toISOString(),
        };
        store.state.devices.push(row);
        added.push(row);
      } else {
        row.online = true;
        row.name = d.name;
        row.model = d.model ?? row.model;
        row.viewportClass = /\bSE\b|mini/i.test(`${row.model ?? ""} ${row.name}`) ? "compact" : "regular";
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
    const attention = store.state.accounts.flatMap((account) => {
      const session = [...store.state.sessions].reverse().find((candidate) => candidate.accountId === account.id && candidate.requiresAttention);
      if ((account.preflightStatus ?? "ready") !== "attention" && !session) return [];
      const group = store.state.accountGroups.find((candidate) => candidate.id === account.groupId);
      const message = session?.lastError ?? account.preflightNote ?? "Account needs verification";
      const screenshot = message.match(/Screenshot saved to (.+?\.(?:png|jpe?g))/i)?.[1];
      return [{ accountId: account.id, groupName: group?.name, platform: account.platform, handle: account.handle,
        trustScore: account.trustScore, message, screenshot, sessionId: session?.id,
        lastVerifiedAt: account.identityVerifiedAt, lastCanaryAt: account.lastCanaryAt }];
    });
    const capacity = store.state.devices.flatMap((device) => (["x", "tiktok", "instagram", "youtube"] as Platform[])
      .map((platform) => ({ deviceId: device.id, deviceName: device.name,
        ...assessDeviceCapacity(store.state.accounts, device.id, platform, device.viewportClass ?? "regular") })));
    print({
      driver: "ios",
      simulator: false,
      devices: store.state.devices,
      usb,
      accounts: store.state.accounts,
      accountGroups: store.state.accountGroups,
      engagementApprovals: store.state.engagementApprovals,
      engagementTargets: store.state.engagementTargets.slice(-100),
      engagementCandidates: store.state.engagementCandidates.slice(-500),
      engagementActionApprovals: store.state.engagementActionApprovals.slice(-500),
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
      attention,
      capacity,
      plan,
      locks: store.locks.snapshot(),
    });
    return;
  }

  if (cmd === "daemon" && ["install", "uninstall", "status"].includes(args[1] ?? "")) {
    const dataDir = getArg(args, "--data") ?? defaultDataDir();
    const here = dirname(fileURLToPath(import.meta.url));
    const distCliPath = resolve(here, "..", "dist", "cli.js");
    const srcCliPath = resolve(here, "..", "src", "cli.ts");
    if (args[1] === "install") {
      const intervalSec = getArg(args, "--interval-sec");
      print(installControllerAgent({
        dataDir,
        distCliPath,
        srcCliPath,
        intervalSec: intervalSec ? Number(intervalSec) : undefined,
      }));
    } else if (args[1] === "uninstall") {
      print(uninstallControllerAgent(dataDir));
    } else {
      print(controllerAgentStatus(dataDir));
    }
    return;
  }

  if (cmd === "daemon") {
    const intervalMs = Math.max(5_000, Number(getArg(args, "--interval-sec") ?? 30) * 1000);
    let stopping = false;
    process.once("SIGINT", () => { stopping = true; });
    process.once("SIGTERM", () => { stopping = true; });
    // Cooldowns so a failing relaunch/rebuild cannot thrash every tick.
    const runnerRepairAttempts = new Map<string, number>();
    const runnerReinstallAttempts = new Map<string, number>();
    const authority = new SerialCommandAuthority();
    const commandServer = startCommandAuthorityServer(getArg(args, "--data") ?? defaultDataDir(), authority);
    const superviseAutomationRunner = async (device: { udid: string; name: string }, allowServiceRestart: boolean) => {
      const last = runnerRepairAttempts.get(device.udid) ?? 0;
      if (Date.now() - last < 10 * 60 * 1000) return undefined;
      try {
        const repair = await superviseDeviceHealth(device.udid, { repoRoot: findProjectRoot(), allowServiceRestart });
        if (repair.action === "none") return repair;
        runnerRepairAttempts.set(device.udid, Date.now());
        notifyDesktop(
          repair.ok ? "Heiss runner recovered" : "Heiss runner repair failed",
          `${device.name}: ${repair.detail}`,
        );
        console.log(JSON.stringify({ at: new Date().toISOString(), runnerRepair: { udid: device.udid, ...repair } }));
        return repair;
      } catch (error) {
        runnerRepairAttempts.set(device.udid, Date.now());
        const message = error instanceof Error ? error.message : String(error);
        notifyDesktop("Heiss runner repair failed", `${device.name}: ${message}`);
        console.error(JSON.stringify({ at: new Date().toISOString(), runnerRepairError: { udid: device.udid, message } }));
        return undefined;
      }
    };
    const renewExpiringRunners = async (onlineUdids: Set<string>, now: Date): Promise<void> => {
      for (const renewal of runnersNeedingReinstall(now)) {
        if (!onlineUdids.has(renewal.udid)) continue;
        const last = runnerReinstallAttempts.get(renewal.udid) ?? 0;
        if (now.getTime() - last < 6 * 60 * 60 * 1000) continue;
        runnerReinstallAttempts.set(renewal.udid, now.getTime());
        notifyDesktop("Heiss re-signing runner", `${renewal.name}: certificate expires soon; rebuilding now.`);
        try {
          await downloadBuildInstallRunner({ udid: renewal.udid, repoRoot: findProjectRoot(), waitForDevice: false });
          notifyDesktop("Heiss runner re-signed", `${renewal.name} is provisioned for another cycle.`);
          console.log(JSON.stringify({ at: now.toISOString(), runnerReinstalled: renewal.udid }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notifyDesktop("Heiss runner re-sign failed", `${renewal.name}: ${message}`);
          console.error(JSON.stringify({ at: now.toISOString(), runnerReinstallError: { udid: renewal.udid, message } }));
        }
      }
    };
    print({ ok: true, daemon: "started", intervalMs, pid: process.pid });
    // A tick that hangs (a stalled devicectl, an un-returning supervision or
    // reinstall) freezes the whole daemon, and launchd KeepAlive never helps
    // because the process is still alive. Bound each tick well beyond the
    // 15-minute batched-session ceiling; if it is exceeded, force-restart so
    // KeepAlive brings up a fresh daemon that recovers state on load().
    const TICK_WATCHDOG_MS = 25 * 60_000;
    while (!stopping) {
      const watchdog = setTimeout(() => {
        const message = `controller tick exceeded ${TICK_WATCHDOG_MS}ms — force-restarting to recover a wedged tick`;
        console.error(JSON.stringify({ at: new Date().toISOString(), fatal: message }));
        notifyDesktop("Heiss controller restarted", "A tick hung; the controller restarted itself to recover.");
        process.exit(1);
      }, TICK_WATCHDOG_MS);
      try {
      await authority.run(async () => {
      const store = openStore(args);
      const now = new Date();
      const nowIso = now.toISOString();
      const timeOfDay = localTimeOfDay(nowIso, store.state.settings.timeZone);
      try {
        store.state.settings.controllerHeartbeatAt = nowIso;
        store.state.settings.controllerPid = process.pid;
        const recoveredStaleSessions = checkpointStaleRunningSessions(store, nowIso);
        if (recoveredStaleSessions.length > 0) {
          notifyDesktop("Heiss recovered a stale session", `${recoveredStaleSessions.length} stale running checkpoint${recoveredStaleSessions.length === 1 ? " was" : "s were"} released for safe retry.`);
        }
        const localDayNow = calendarDay(nowIso, store.state.settings.timeZone);
        const newlyReady = refreshCandidateQueue(
          store.state.engagementCandidates, store.state.engagementActionApprovals,
          localDayNow, nowIso,
        );
        if (newlyReady > 0) notifyDesktop("Heiss approved actions are ready", `${newlyReady} reviewed action${newlyReady === 1 ? " is" : "s are"} ready for guided completion.`);
        if (timeOfDay >= "22:00" && store.state.settings.notificationKeys.candidateReview !== localDayNow) {
          const reviewCount = store.state.engagementCandidates.filter((candidate) => candidate.status === "pending"
            && calendarDay(candidate.lastSeenAt, store.state.settings.timeZone) === localDayNow).length;
          store.state.settings.notificationKeys.candidateReview = localDayNow;
          notifyDesktop("Heiss candidate review is ready", reviewCount > 0
            ? `${reviewCount} candidate${reviewCount === 1 ? " is" : "s are"} ready for exact approval.`
            : "No candidates were captured tonight; check Attention for paused accounts.");
          store.pushActivity({ kind: "candidate_review_ready", message: `10 p.m. candidate review ready (${reviewCount} candidates)` });
        }
        const maintenance = store.state.settings.maintenance;
        if (maintenance.mode !== "running") {
          const running = store.state.sessions.filter((session) => session.status === "running");
          if (maintenance.mode === "draining" && running.length === 0) {
            maintenance.mode = "active";
            maintenance.enteredAt = nowIso;
            store.pushActivity({ kind: "maintenance", message: "Current checkpoint drained; maintenance mode is active" });
          }
          store.save();
          console.log(JSON.stringify({ at: nowIso, maintenance: maintenance.mode, runningSessions: running.length }));
          return;
        }
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
        const onlineUdids = new Set(store.state.devices.filter((device) => device.online).map((device) => device.udid));
        await renewExpiringRunners(onlineUdids, now);
        if (store.state.devices.some((device) => device.online) && store.state.accounts.length > 0) {
          // Accounts gated by manual onboarding attention are not actionable;
          // excluding them keeps "has work" honest so the daemon does not
          // supervise the device for an account runOnce will only skip.
          const attentionAccountIds = new Set(
            store.state.sessions
              .filter((session) => session.status === "checkpointed" && session.requiresAttention)
              .map((session) => session.accountId),
          );
          const accountActionable = (account: { id: string; preflightStatus?: string }) =>
            (account.preflightStatus ?? "ready") === "ready" && !attentionAccountIds.has(account.id);
          const dueWarmupIds = store.state.warmupSchedules.filter((schedule) => {
            const account = store.state.accounts.find((candidate) => candidate.id === schedule.accountId);
            return account && accountActionable(account) && warmupScheduleIsDue(schedule, nowIso, store.state.settings.timeZone, account.lastWarmupAt);
          }).map((schedule) => schedule.accountId);
          // Supervise the on-device automation runner whenever this tick has
          // actionable work to send it — a dead/wedged runner is relaunched
          // first instead of every action timing out.
          const retryDue = store.state.sessions.some(
            (session) => session.status === "checkpointed" && !session.requiresAttention
              && (!session.nextRetryAt || session.nextRetryAt <= nowIso),
          );
          const claimable = store.state.queue.some(
            (item) => (item.status === "queued" || (item.status === "stored_local" && !item.assignedAccountId))
              && item.accountIds.some((id) => {
                const account = store.state.accounts.find((candidate) => candidate.id === id);
                return account && accountActionable(account);
              }),
          );
          if (dueWarmupIds.length > 0 || retryDue || claimable) {
            const onlineDevices = store.state.devices.filter((row) => row.online);
            // Restarting the shared CoreDevice service would disrupt every
            // attached iPhone; only permit it when this is the sole online one.
            const allowServiceRestart = onlineDevices.length <= 1;
            for (const device of onlineDevices) {
              const health = await superviseAutomationRunner(device, allowServiceRestart);
              if (health) store.state.settings.deviceHealth[device.id] = {
                checkedAt: new Date().toISOString(), ok: health.ok, action: health.action,
                detail: health.detail, checks: health.checks,
              };
            }
          }
          const posting = await new FarmOrchestrator(store, makeDriver()).runOnce({
            runnerId: `daemon-${process.pid}`,
            timeOfDay,
            now: nowIso,
            skipWarmups: true,
            maxSessions: 1,
          });
          const warmups = dueWarmupIds.length > 0
            ? await new FarmOrchestrator(store, makeDriver()).runOnce({
                runnerId: `daemon-${process.pid}`,
                timeOfDay,
                now: nowIso,
                warmupAccountIds: dueWarmupIds,
                maxSessions: 1,
              })
            : { sessions: [], activity: [], interrupted: false };
          const result = { sessions: [...posting.sessions, ...warmups.sessions], interrupted: posting.interrupted || warmups.interrupted };
          // Daily TikTok cache maintenance. Feed scrolling caches several GB/day
          // of video on the device (observed ~5GB/day → 35GB System Data in a
          // week); left unmanaged it fills storage and a system alert blocks all
          // automation. Run once per local day on an idle tick against a
          // known-healthy runner, so it never contends with a session or blocks
          // on a down runner. Fail-soft: the runner returns ok even if it cannot
          // navigate, and any error here is swallowed.
          const cacheDay = calendarDay(nowIso, store.state.settings.timeZone);
          if (result.sessions.length === 0
              && store.state.settings.notificationKeys.tiktokCacheClearDay !== cacheDay) {
            const cacheAccount = store.state.accounts.find((account) =>
              account.platform === "tiktok"
              && (account.preflightStatus ?? "ready") === "ready"
              && store.state.devices.some((device) => device.id === account.deviceId && device.online
                && store.state.settings.deviceHealth[device.id]?.ok === true));
            if (cacheAccount) {
              const cacheDevice = store.state.devices.find((device) => device.id === cacheAccount.deviceId)!;
              try {
                const cacheDriver = makeDriver();
                await cacheDriver.connect(cacheDevice.id, cacheDevice.udid);
                const cacheResult = await cacheDriver.runAction(cacheDevice.id, cacheAccount.id, "tiktok:clear_cache", { platform: "tiktok", handle: cacheAccount.handle });
                await cacheDriver.disconnect(cacheDevice.id).catch(() => undefined);
                store.state.settings.notificationKeys.tiktokCacheClearDay = cacheDay;
                console.log(JSON.stringify({ at: nowIso, tiktokCacheClear: cacheResult.detail }));
              } catch (error) {
                console.error(JSON.stringify({ at: nowIso, tiktokCacheClearError: error instanceof Error ? error.message : String(error) }));
              }
            }
          }
          const cloud = await pushCloudCompletions(store).catch((error) => ({ warning: String(error), pushed: 0 }));
          const completed = result.sessions.filter((session) => session.status === "completed").length;
          if (completed > 0) notifyDesktop("Heiss session complete", `${completed} scheduled session${completed === 1 ? "" : "s"} completed.`);
          if (result.interrupted) {
            const paused = result.sessions.find((session) => session.status === "checkpointed");
            const account = paused ? store.state.accounts.find((candidate) => candidate.id === paused.accountId) : undefined;
            const group = account?.groupId ? store.state.accountGroups.find((candidate) => candidate.id === account.groupId) : undefined;
            notifyDesktop(
              paused?.requiresAttention ? `Heiss paused ${account?.platform ?? "account"}` : "Heiss session checkpointed",
              paused?.requiresAttention
                ? `${group?.name ?? account?.handle ?? "Account"} (${account?.handle ?? "unknown"}): ${paused.lastError ?? "manual cleanup required"}`
                : `${account?.handle ?? "A session"} will retry after its recovery window: ${paused?.lastError ?? "temporary failure"}`,
            );
          }
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
      });
      } finally {
        clearTimeout(watchdog);
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, 60_000)));
    }
    await new Promise<void>((resolve) => commandServer.close(() => resolve()));
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

  if (cmd === "account" && args[1] === "switcher") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    const switcherHint = args[3]?.trim();
    if (!account || !switcherHint) {
      throw new Error("Usage: account switcher <accountId> \"picker label\"");
    }
    account.switcherHint = switcherHint;
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "account" && args[1] === "identity") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    if (!account) throw new Error("Usage: account identity <accountId> [--display-name NAME] [--email EMAIL] [--switcher LABEL] [--avatar HASH]");
    account.displayName = getArg(args, "--display-name")?.trim() || account.displayName;
    account.loginEmail = getArg(args, "--email")?.trim() || account.loginEmail;
    account.switcherHint = getArg(args, "--switcher")?.trim() || account.switcherHint;
    account.avatarFingerprint = getArg(args, "--avatar")?.trim() || account.avatarFingerprint;
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "account" && args[1] === "preflight") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    const status = args[3];
    if (!account || !["pending", "ready", "attention"].includes(status ?? "")) {
      throw new Error("Usage: account preflight <accountId> <pending|ready|attention> [--app-version VERSION] [--note NOTE]");
    }
    account.preflightStatus = status as "pending" | "ready" | "attention";
    account.preflightCompletedAt = status === "ready" ? new Date().toISOString() : undefined;
    account.preflightAppVersion = getArg(args, "--app-version")?.trim() || account.preflightAppVersion;
    account.preflightNote = getArg(args, "--note")?.trim() || (status === "ready" ? undefined : account.preflightNote);
    if (status === "ready") {
      for (const session of store.state.sessions.filter((candidate) => candidate.accountId === account.id && candidate.status === "checkpointed" && candidate.requiresAttention)) {
        session.requiresAttention = false;
        session.nextRetryAt = new Date().toISOString();
      }
    }
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "preflight" && (args[1] === "canary" || args[1] === "verify-all")) {
    const store = openStore(args);
    let ids = (getArg(args, "--accounts") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const lowest = Number(getArg(args, "--lowest") ?? 0);
    if (!ids.length && Number.isInteger(lowest) && lowest > 0) {
      ids = [...store.state.accounts].sort((a, b) => a.trustScore - b.trustScore || a.createdAt.localeCompare(b.createdAt)).slice(0, lowest).map((account) => account.id);
    }
    const verifyAll = args[1] === "verify-all";
    const results = await new FarmOrchestrator(store, new RealIosDriver()).verifyPreflight({
      accountIds: ids.length ? ids : undefined,
      lowTrustFirst: verifyAll || hasFlag(args, "--low-trust-first"),
      transitionRing: verifyAll || hasFlag(args, "--ring"),
    });
    print({ ok: results.every((result) => result.ok), results }); return;
  }

  if (cmd === "preflight" && args[1] === "x-composer") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    if (!account || account.platform !== "x") throw new Error("Usage: preflight x-composer <xAccountId>");
    if ((account.preflightStatus ?? "ready") !== "ready") throw new Error("Account onboarding/preflight is not ready");
    const device = store.state.devices.find((candidate) => candidate.id === account.deviceId);
    if (!device) throw new Error("Account device is missing");
    const driver = new RealIosDriver();
    await driver.connect(device.id, device.udid);
    try {
      const result = await driver.runAction(device.id, account.id, "verify:composer", {
        platform: account.platform, handle: account.handle, displayName: account.displayName,
        loginEmail: account.loginEmail, switcherHint: account.switcherHint,
        avatarFingerprint: account.avatarFingerprint, searchTerms: account.searchTerms,
        uiProfile: store.state.uiProfiles.x,
      });
      store.pushActivity({ kind: "x_composer_canary", accountId: account.id, deviceId: device.id,
        message: `${account.handle} X composer opened and closed without content or publishing` });
      store.save(); print({ ok: true, accountId: account.id, handle: account.handle, result });
    } finally {
      await driver.disconnect(device.id).catch(() => undefined);
    }
    return;
  }

  if (cmd === "preflight" && args[1] === "health") {
    const store = openStore(args);
    const requested = getArg(args, "--udid");
    const devices = requested
      ? store.state.devices.filter((device) => device.udid === requested || device.id === requested)
      : store.state.devices;
    if (devices.length === 0) throw new Error("No matching registered device");
    const results = [];
    for (const device of devices) {
      const result = { deviceId: device.id, name: device.name, ...(await superviseDeviceHealth(device.udid, { repoRoot: findProjectRoot() })) };
      results.push(result);
      store.state.settings.deviceHealth[device.id] = {
        checkedAt: new Date().toISOString(), ok: result.ok, action: result.action, detail: result.detail,
        checks: result.checks,
      };
    }
    store.save();
    print({ ok: results.every((result) => result.ok), results }); return;
  }

  if (cmd === "account-set" && args[1] === "rename") {
    const store = openStore(args);
    const group = store.state.accountGroups.find((candidate) => candidate.id === args[2]);
    const name = args.slice(3).join(" ").trim();
    if (!group || !name) throw new Error("Usage: account-set rename <groupId> <name>");
    group.name = name;
    store.save(); print({ ok: true, group }); return;
  }

  if (cmd === "account-set" && args[1] === "terms") {
    const store = openStore(args);
    const group = store.state.accountGroups.find((candidate) => candidate.id === args[2]);
    const terms = parseSearchTerms(args[3], "");
    if (!group || terms.length === 0) throw new Error("Usage: account-set terms <groupId> \"term,term\" [--platform instagram|tiktok|x|youtube]");
    const platform = getArg(args, "--platform")?.trim().toLowerCase();
    if (platform && !["instagram", "tiktok", "x", "youtube"].includes(platform)) {
      throw new Error(`Unknown platform ${platform} — expected instagram, tiktok, x or youtube`);
    }
    const accounts = store.state.accounts.filter((account) => account.groupId === group.id
      && (!platform || account.platform === platform));
    if (accounts.length === 0) throw new Error(`Account set ${group.name} has no linked accounts${platform ? ` on ${platform}` : ""}`);
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
      preflightStatus: "pending" as const,
      engagement: defaultEngagementPolicy(),
      searchTerms: parseSearchTerms(getArg(args, "--terms")), createdAt: new Date().toISOString(),
    }));
    store.state.accountGroups.push(group);
    for (const account of created) {
      store.state.accounts.push(account);
      if (["tiktok", "instagram", "x"].includes(account.platform)) store.state.slots.push(createSlot(account.id, "09:00"));
      const index = store.state.warmupSchedules.length;
      const minutes = 15 * 60 + 30 + index * 14;
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
      preflightStatus: "pending" as const,
      engagement: defaultEngagementPolicy(),
      searchTerms: parseSearchTerms(getArg(args, "--terms")),
      createdAt: new Date().toISOString(),
    };
    store.state.accounts.push(account);
    assertWithinPlan(activePlan(store), store.state.devices.length, store.state.accounts.length);
    // default morning slot for posting platforms
    if (["tiktok", "instagram", "x"].includes(platform)) {
      store.state.slots.push(createSlot(account.id, "09:00"));
    }
    const warmupIndex = store.state.warmupSchedules.length;
    const minutes = 15 * 60 + 30 + warmupIndex * 14;
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
    store.state.engagementApprovals = store.state.engagementApprovals.filter((item) => item.accountId !== account.id);
    store.state.engagementTargets = store.state.engagementTargets.filter((item) => item.accountId !== account.id);
    store.state.engagementCandidates = store.state.engagementCandidates.filter((item) => item.accountId !== account.id);
    store.state.engagementActionApprovals = store.state.engagementActionApprovals.filter((item) => item.accountId !== account.id);
    for (const item of store.state.queue.filter((queue) => queue.accountIds.includes(account.id))) {
      item.accountIds = item.accountIds.filter((id) => id !== account.id);
      if (item.accountIds.length === 0 && item.status !== "posted") item.status = "cancelled";
    }
    if (account.groupId && !store.state.accounts.some((candidate) => candidate.groupId === account.groupId)) {
      store.state.accountGroups = store.state.accountGroups.filter((group) => group.id !== account.groupId);
    }
    store.save(); print({ ok: true, account }); return;
  }

  if (cmd === "engagement" && args[1] === "show") {
    const store = openStore(args);
    print({
      ok: true,
      accounts: store.state.accounts.map((account) => ({
        id: account.id, handle: account.handle, platform: account.platform,
        stage: account.stage, policy: normalizeEngagementPolicy(account.engagement),
        autonomousEligible: engagementAutonomousEligible(account),
      })),
      approvals: store.state.engagementApprovals,
      recentTargets: store.state.engagementTargets.slice(-100),
    });
    return;
  }

  if (cmd === "candidates" && args[1] === "repair") {
    // One-off migration for candidates recorded BEFORE the charset-boundary fix.
    // The old normalizer deleted illegal characters globally, welding a feed
    // timestamp onto the handle (`@realtordotcom•7h` -> `realtordotcom7h`). The
    // boundary evidence survives in `excerpt`, which never passed through handle
    // normalization — so we re-derive the handle from the excerpt token whose OLD
    // normalization reproduces the stored value, then re-cut it with the new logic.
    // Requires a UNIQUE excerpt match; anything else is left untouched for review.
    const store = openStore(args);
    const apply = args.includes("--apply");
    const oldNormalize = (platform: Platform, value: string): string => {
      let n = value.trim().replace(/^@/, "").toLowerCase().replace(/^[^a-z0-9_]+|[^a-z0-9._-]+$/g, "");
      n = n.replace(/\.(?:\d+)(?:s|m|h|d|w)$/i, "");
      if (platform === "x") n = n.split(".")[0]!.replace(/[^a-z0-9_]/g, "").slice(0, 15);
      return n;
    };
    const changes: Array<Record<string, unknown>> = [];
    for (const candidate of store.state.engagementCandidates) {
      if (!["pending", "approved"].includes(candidate.status)) continue;
      const platform = candidate.platform;
      const tokens = (candidate.excerpt ?? "").split(/[\s,;()\[\]{}]+/).filter((token) => token.startsWith("@"));
      const sources = [...new Set(tokens.filter((token) => oldNormalize(platform, token) === candidate.targetHandle))];
      if (sources.length !== 1) {
        if (sources.length > 1) changes.push({ id: candidate.id, handle: candidate.targetHandle, verdict: "skipped_ambiguous_excerpt" });
        continue;
      }
      const repaired = normalizePlatformCandidateHandle(platform, sources[0]!);
      const ambiguous = isAmbiguousCandidateHandle(platform, sources[0]!);
      if (!repaired || repaired === candidate.targetHandle) {
        if (candidate.ambiguous !== ambiguous && apply) candidate.ambiguous = ambiguous;
        continue;
      }
      const targetKey = candidateTargetKey(platform, repaired);
      // A repair can collapse two rows onto one real account (e.g. the same
      // handle seen with two different timestamps). Fold rather than duplicate.
      const collision = store.state.engagementCandidates.find((other) => other.id !== candidate.id
        && other.accountId === candidate.accountId && other.targetKey === targetKey && other.status !== "expired");
      changes.push({ id: candidate.id, from: candidate.targetHandle, to: repaired, ambiguous,
        verdict: collision ? "repaired_merged_duplicate" : "repaired" });
      if (!apply) continue;
      for (const approval of store.state.engagementActionApprovals.filter((item) => item.candidateId === candidate.id)) {
        approval.targetHandle = repaired; approval.targetKey = targetKey;
      }
      candidate.targetHandle = repaired; candidate.targetKey = targetKey; candidate.ambiguous = ambiguous;
      if (collision) {
        // Keep whichever row carries the human decision. Expiring an approved
        // row in favour of a pending duplicate would silently drop the approval.
        const loser = candidate.status === "approved" ? collision : candidate;
        const winner = loser === candidate ? collision : candidate;
        winner.seenCount += loser.seenCount;
        loser.status = "expired";
      }
    }
    if (apply) store.save();
    print({ ok: true, applied: apply, changed: changes.length, changes }); return;
  }

  if (cmd === "candidates" && args[1] === "show") {
    const store = openStore(args);
    refreshCandidateQueue(store.state.engagementCandidates, store.state.engagementActionApprovals,
      calendarDay(new Date().toISOString(), store.state.settings.timeZone), new Date().toISOString());
    const groupId = getArg(args, "--group");
    print({ ok: true,
      candidates: store.state.engagementCandidates.filter((candidate) => !groupId || candidate.groupId === groupId),
      approvals: store.state.engagementActionApprovals.filter((approval) => !groupId || approval.groupId === groupId),
    }); return;
  }

  if (cmd === "candidates" && args[1] === "canary") {
    const store = openStore(args); const account = store.state.accounts.find((item) => item.id === args[2]);
    const device = account && store.state.devices.find((item) => item.id === account.deviceId);
    if (!account || !device) throw new Error("Usage: candidates canary <accountId>");
    if ((account.preflightStatus ?? "ready") !== "ready") throw new Error("Account preflight must be ready before a discovery canary");
    const driver = makeDriver(); const sessionId = `candidate-canary-${randomUUID()}`;
    await driver.connect(device.id, device.udid);
    try {
      if (!driver.runSession) throw new Error("The physical-device session runner is unavailable");
      const result = await driver.runSession(device.id, account.id, sessionId, ["warmup:search"], 0, {
        platform: account.platform, handle: account.handle, displayName: account.displayName,
        loginEmail: account.loginEmail, switcherHint: account.switcherHint, avatarFingerprint: account.avatarFingerprint,
        searchTerms: account.searchTerms, uiProfile: store.state.uiProfiles[account.platform],
        ownedHandles: store.state.accounts.map((item) => item.handle),
      });
      const recorded = (result.stepDetails ?? []).flatMap((detail) => recordDiscoveryCandidates({
        candidates: store.state.engagementCandidates, account,
        ownedHandles: store.state.accounts.map((item) => item.handle), sessionId, detail, now: new Date().toISOString(),
      }));
      store.pushActivity({ kind: "candidate_canary", accountId: account.id, deviceId: account.deviceId,
        message: `${account.handle} discovery canary completed; ${recorded.length} candidate${recorded.length === 1 ? "" : "s"} observed` });
      store.save(); print({ ok: true, accountId: account.id, completedSteps: result.completedSteps, recorded }); return;
    } finally { await driver.disconnect(device.id).catch(() => undefined); }
  }

  if (cmd === "candidates" && args[1] === "approve") {
    const store = openStore(args); const candidate = store.state.engagementCandidates.find((item) => item.id === args[2]);
    const action = args[3] as "like" | "follow" | undefined;
    if (!candidate || !action || !["like", "follow"].includes(action)) throw new Error("Usage: candidates approve <candidateId> <like|follow>");
    const account = store.state.accounts.find((item) => item.id === candidate.accountId);
    if (!account || !["matured", "kept_warm", "posting"].includes(account.stage)) throw new Error("Candidate approvals unlock when this account is mature");
    const now = new Date().toISOString();
    const approval = approveCandidate({ candidate, action, approvals: store.state.engagementActionApprovals,
      allCandidates: store.state.engagementCandidates, localDay: calendarDay(now, store.state.settings.timeZone), now });
    store.pushActivity({ kind: "candidate_approved", accountId: account.id, deviceId: account.deviceId,
      message: `${action} @${candidate.targetHandle} approved and ready for guided completion` });
    store.save(); print({ ok: true, candidate, approval }); return;
  }

  if (cmd === "candidates" && args[1] === "reject") {
    const store = openStore(args); const candidate = store.state.engagementCandidates.find((item) => item.id === args[2]);
    if (!candidate || !["pending", "approved"].includes(candidate.status)) throw new Error("Candidate is not reviewable");
    candidate.status = "rejected";
    for (const approval of store.state.engagementActionApprovals.filter((item) => item.candidateId === candidate.id && !["completed", "skipped"].includes(item.status))) approval.status = "skipped";
    store.save(); print({ ok: true, candidate }); return;
  }

  if (cmd === "candidates" && args[1] === "assist") {
    const store = openStore(args); const approval = store.state.engagementActionApprovals.find((item) => item.id === args[2]);
    if (!approval || !["ready", "needs_manual"].includes(approval.status)) throw new Error("Approved action is not ready yet");
    const account = store.state.accounts.find((item) => item.id === approval.accountId);
    const device = account && store.state.devices.find((item) => item.id === account.deviceId);
    if (!account || !device) throw new Error("Candidate account or device is missing");
    const driver = makeDriver(); await driver.connect(device.id, device.udid);
    try {
      await driver.runAction(device.id, account.id, "candidate:search", {
        platform: account.platform, handle: account.handle, displayName: account.displayName,
        loginEmail: account.loginEmail, switcherHint: account.switcherHint, avatarFingerprint: account.avatarFingerprint,
        searchTerms: [`@${approval.targetHandle}`], uiProfile: store.state.uiProfiles[account.platform],
        ownedHandles: store.state.accounts.map((item) => item.handle),
      });
      approval.status = "needs_manual"; approval.attemptedAt = new Date().toISOString();
      store.pushActivity({ kind: "candidate_assisted", accountId: account.id, deviceId: account.deviceId,
        message: `Opened @${approval.targetHandle} for human-confirmed ${approval.action}` });
      store.save(); print({ ok: true, approval, next: `Confirm the ${approval.action} on the iPhone, then mark complete.` }); return;
    } finally { await driver.disconnect(device.id).catch(() => undefined); }
  }

  if (cmd === "candidates" && (args[1] === "complete" || args[1] === "skip")) {
    const store = openStore(args); const approval = store.state.engagementActionApprovals.find((item) => item.id === args[2]);
    if (!approval || !["ready", "needs_manual"].includes(approval.status)) throw new Error("Approved action is not completable");
    const account = store.state.accounts.find((item) => item.id === approval.accountId); const now = new Date().toISOString();
    approval.status = args[1] === "complete" ? "completed" : "skipped"; approval.completedAt = now;
    if (approval.status === "completed" && !store.state.engagementTargets.some((item) => item.accountId === approval.accountId && item.targetKey === approval.targetKey && item.action === approval.action)) {
      store.state.engagementTargets.push({ id: randomUUID(), accountId: approval.accountId, platform: approval.platform, action: approval.action, targetKey: approval.targetKey, at: now });
    }
    store.pushActivity({ kind: "candidate_completed", accountId: approval.accountId, deviceId: account?.deviceId,
      message: `${approval.action} @${approval.targetHandle} ${approval.status}` });
    store.save(); print({ ok: true, approval }); return;
  }

  if (cmd === "engagement" && args[1] === "configure") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    const mode = getArg(args, "--mode") as "off" | "review" | "autonomous" | undefined;
    if (!account || !mode || !["off", "review", "autonomous"].includes(mode)) {
      throw new Error("Usage: engagement configure <accountId> --mode off|review|autonomous [--likes on|off] [--follows on|off] [--like-cap 0..5] [--follow-cap 0..2] [--cooldown-min N]");
    }
    if (mode === "autonomous") throw new Error("Unattended engagement is disabled; use exact candidate approvals and guided completion");
    const current = normalizeEngagementPolicy(account.engagement);
    const likeCap = Number(getArg(args, "--like-cap") ?? current.dailyLikeCap);
    const followCap = Number(getArg(args, "--follow-cap") ?? current.dailyFollowCap);
    const cooldown = Number(getArg(args, "--cooldown-min") ?? current.cooldownMinutes);
    if (!Number.isInteger(likeCap) || likeCap < 0 || likeCap > 5) throw new Error("Like cap must be an integer from 0 to 5");
    if (!Number.isInteger(followCap) || followCap < 0 || followCap > 2) throw new Error("Follow cap must be an integer from 0 to 2");
    if (!Number.isInteger(cooldown) || cooldown < 60 || cooldown > 10_080) throw new Error("Cooldown must be 60..10080 minutes");
    const policy = normalizeEngagementPolicy({
      ...current,
      mode,
      likesEnabled: parseOnOff(getArg(args, "--likes"), current.likesEnabled),
      followsEnabled: parseOnOff(getArg(args, "--follows"), current.followsEnabled),
      dailyLikeCap: likeCap,
      dailyFollowCap: followCap,
      cooldownMinutes: cooldown,
    });
    account.engagement = policy;
    const request = ensureDailyEngagementApproval(account, store.state.engagementApprovals, calendarDay(new Date().toISOString(), store.state.settings.timeZone));
    store.pushActivity({ kind: "engagement_policy", accountId: account.id, deviceId: account.deviceId,
      message: `${account.handle} engagement set to ${mode}; likes ${policy.likesEnabled ? "on" : "off"}, follows ${policy.followsEnabled ? "on" : "off"}` });
    store.save(); print({ ok: true, account, policy, request }); return;
  }

  if (cmd === "engagement" && args[1] === "review") {
    const store = openStore(args);
    const account = store.state.accounts.find((candidate) => candidate.id === args[2]);
    if (!account) throw new Error("Usage: engagement review <accountId>");
    const request = ensureDailyEngagementApproval(account, store.state.engagementApprovals, calendarDay(new Date().toISOString(), store.state.settings.timeZone));
    if (!request) throw new Error("Account must be mature and configured for review engagement");
    store.save(); print({ ok: true, request }); return;
  }

  if (cmd === "engagement" && (args[1] === "approve" || args[1] === "reject")) {
    const store = openStore(args);
    const request = store.state.engagementApprovals.find((candidate) => candidate.id === args[2]);
    if (!request || request.status !== "pending") throw new Error(`Engagement approval is missing or is ${request?.status ?? "unknown"}`);
    request.status = args[1] === "approve" ? "approved" : "rejected";
    request.decidedAt = new Date().toISOString();
    const account = store.state.accounts.find((candidate) => candidate.id === request.accountId);
    store.pushActivity({ kind: "engagement_review_decided", accountId: request.accountId, deviceId: account?.deviceId,
      message: `${account?.handle ?? request.accountId} engagement review ${request.status}` });
    store.save(); print({ ok: true, request }); return;
  }

  if (cmd === "drop") {
    const store = openStore(args);
    const accounts = (getArg(args, "--accounts") ?? "").split(",").filter(Boolean);
    const caption = getArg(args, "--caption") ?? "";
    const media = getArg(args, "--media") ?? "media.bin";
    const music = getArg(args, "--music");
    const carousel = hasFlag(args, "--carousel");
    const textOnly = hasFlag(args, "--text");
    const slides = (getArg(args, "--slides") ?? "").split(",").filter(Boolean);
    if (accounts.some((id) => !store.state.accounts.some((account) => account.id === id))) throw new Error("Drop contains an unknown account id");
    if (textOnly && accounts.some((id) => store.state.accounts.find((account) => account.id === id)?.platform !== "x")) {
      throw new Error("Text-only drops can target X accounts only");
    }
    if (carousel && slides.length < 2) throw new Error("Carousel drop requires --slides first.jpg,second.jpg");
    const { content, queueItem } = dropContent({
      kind: textOnly ? "text" : carousel ? "carousel" : "video",
      mediaRef: textOnly ? "" : carousel ? slides[0]! : media,
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

  if (cmd === "warmup-schedule" && args[1] === "rebalance") {
    const store = openStore(args); rebalanceWarmupSchedules(store); store.save();
    print({ ok: true, timeZone: store.state.settings.timeZone, schedules: store.state.warmupSchedules,
      latestByDevice: store.state.devices.map((device) => ({ deviceId: device.id, name: device.name,
        latest: store.state.warmupSchedules.filter((schedule) => store.state.accounts.find((account) => account.id === schedule.accountId)?.deviceId === device.id)
          .map((schedule) => schedule.timeOfDay).sort().at(-1) ?? null })) });
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
        "Log into each social platform on the phone",
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
