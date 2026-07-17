import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityEvent,
  AccountGroup,
  EngagementApproval,
  EngagementTargetRecord,
  ContentAsset,
  Device,
  FarmSession,
  QueueItem,
  ProxyConfig,
  LicenseActivation,
  MagicLink,
  PlatformUiProfile,
  Platform,
  ScheduleSlot,
  SocialAccount,
  WarmupSchedule,
  FarmSettings,
  User,
} from "./types.js";
import type { LockSnapshot } from "./locks.js";
import { ResourceLocks } from "./locks.js";

export interface FarmState {
  version: 1;
  revision: number;
  users: User[];
  magicLinks: MagicLink[];
  uiProfiles: Partial<Record<Platform, PlatformUiProfile>>;
  devices: Device[];
  accounts: SocialAccount[];
  accountGroups: AccountGroup[];
  engagementApprovals: EngagementApproval[];
  engagementTargets: EngagementTargetRecord[];
  contents: ContentAsset[];
  queue: QueueItem[];
  slots: ScheduleSlot[];
  warmupSchedules: WarmupSchedule[];
  settings: FarmSettings;
  sessions: FarmSession[];
  activity: ActivityEvent[];
  proxies: ProxyConfig[];
  license?: LicenseActivation;
  locks: LockSnapshot;
}

export function emptyState(): FarmState {
  return {
    version: 1,
    revision: 0,
    users: [],
    magicLinks: [],
    uiProfiles: {},
    devices: [],
    accounts: [],
    accountGroups: [],
    engagementApprovals: [],
    engagementTargets: [],
    contents: [],
    queue: [],
    slots: [],
    warmupSchedules: [],
    settings: {
      timeZone: "America/Chicago",
      emergencyStop: false,
      dailyActionCap: 400,
      accountDailyActionCap: 25,
      platformOrder: ["x", "tiktok", "instagram", "youtube"],
      platformScheduleVersion: 1,
      requireHumanEngagement: true,
      deviceStates: {},
      notificationKeys: {},
      maintenance: { mode: "running" },
      deviceHealth: {},
    },
    sessions: [],
    activity: [],
    proxies: [],
    locks: { devices: {}, content: {} },
  };
}

export class JsonStore {
  readonly path: string;
  state: FarmState;
  locks: ResourceLocks;
  private loadedRevision = 0;

  constructor(path: string) {
    this.path = path;
    this.state = emptyState();
    this.locks = new ResourceLocks();
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) {
      this.state = emptyState();
      this.locks = new ResourceLocks();
      this.loadedRevision = 0;
      return;
    }
    const raw = readFileSync(this.path, "utf8");
    this.state = JSON.parse(raw) as FarmState;
    this.state.revision ??= 0;
    this.loadedRevision = this.state.revision;
    // Forward-fill fields added after v1 so existing farms remain readable.
    this.state.proxies ??= [];
    this.state.magicLinks ??= [];
    this.state.uiProfiles ??= {};
    this.state.accountGroups ??= [];
    this.state.engagementApprovals ??= [];
    this.state.engagementTargets ??= [];
    this.state.warmupSchedules ??= [];
    this.state.settings ??= emptyState().settings;
    this.state.settings.timeZone ??= "America/Chicago";
    this.state.settings.emergencyStop ??= false;
    this.state.settings.dailyActionCap ??= 400;
    this.state.settings.accountDailyActionCap ??= 25;
    this.state.settings.platformOrder ??= ["x", "tiktok", "instagram", "youtube"];
    this.state.settings.platformScheduleVersion ??= 0;
    this.state.settings.requireHumanEngagement ??= true;
    this.state.settings.deviceStates ??= {};
    this.state.settings.notificationKeys ??= {};
    this.state.settings.maintenance ??= { mode: "running" };
    this.state.settings.deviceHealth ??= {};
    // Existing flat farms with one matching handle on all four platforms can
    // be migrated safely into a single account set without guessing identity.
    if (this.state.accountGroups.length === 0) {
      const byDeviceAndHandle = new Map<string, SocialAccount[]>();
      for (const account of this.state.accounts) {
        const key = `${account.deviceId}:${account.handle.replace(/^@/, "").toLowerCase()}`;
        const group = byDeviceAndHandle.get(key) ?? [];
        group.push(account); byDeviceAndHandle.set(key, group);
      }
      for (const accounts of byDeviceAndHandle.values()) {
        if (new Set(accounts.map((account) => account.platform)).size !== 4) continue;
        const group: AccountGroup = { id: cryptoRandom(), name: `Person ${this.state.accountGroups.length + 1}`, deviceId: accounts[0]!.deviceId, createdAt: accounts[0]!.createdAt };
        this.state.accountGroups.push(group);
        for (const account of accounts) account.groupId = group.id;
      }
    }
    // Forward-fill independent evening warmup schedules for legacy accounts.
    for (const account of this.state.accounts) {
      account.engagement ??= {
        mode: "off", likesEnabled: false, followsEnabled: false,
        dailyLikeCap: 2, dailyFollowCap: 1, cooldownMinutes: 720,
        successfulReviewedSessions: 0,
      };
      if (this.state.warmupSchedules.some((schedule) => schedule.accountId === account.id)) continue;
      const index = this.state.warmupSchedules.length;
      const minutes = 20 * 60 + 30 + index * 20;
      this.state.warmupSchedules.push({
        id: cryptoRandom(), accountId: account.id,
        timeOfDay: `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
        jitterMinutes: 8, enabled: true,
      });
    }
    // X became a posting platform after the original farms were created.
    // Give existing X accounts the same explicit morning slot as newly added
    // posting accounts; maturity and queue gates still prevent surprise posts.
    for (const account of this.state.accounts.filter((candidate) => candidate.platform === "x")) {
      if (!this.state.slots.some((slot) => slot.accountId === account.id)) {
        this.state.slots.push({ id: cryptoRandom(), accountId: account.id, timeOfDay: "09:00", enabled: true });
      }
    }
    // Migrate legacy alternating-person schedules once. Contiguous platform
    // windows keep each app open while all of its accounts are processed.
    if (this.state.settings.platformScheduleVersion < 1) {
      const accountById = new Map(this.state.accounts.map((account) => [account.id, account]));
      const order = this.state.settings.platformOrder;
      this.state.warmupSchedules.sort((left, right) => {
        const a = accountById.get(left.accountId);
        const b = accountById.get(right.accountId);
        const aRank = a ? order.indexOf(a.platform) : order.length;
        const bRank = b ? order.indexOf(b.platform) : order.length;
        return (aRank < 0 ? order.length : aRank) - (bRank < 0 ? order.length : bRank)
          || (a?.groupId ?? "").localeCompare(b?.groupId ?? "")
          || left.accountId.localeCompare(right.accountId);
      });
      for (const [index, schedule] of this.state.warmupSchedules.entries()) {
        const minutes = 20 * 60 + index * 15;
        schedule.timeOfDay = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        schedule.jitterMinutes = Math.min(schedule.jitterMinutes, 5);
      }
      this.state.settings.platformScheduleVersion = 1;
    }
    // Reconcile legacy trust with distinct local days. This corrects farms that
    // crossed UTC midnight while still on the same local evening.
    for (const account of this.state.accounts) {
      // Existing farms predate the explicit manual-onboarding gate and have
      // already been curated by their owner. New accounts start pending.
      account.preflightStatus ??= "ready";
      if (!account.warmupLocalDays && (account.stage === "fresh" || account.stage === "warmed_up")) {
        const days = [...new Set(this.state.sessions
          .filter((session) => session.accountId === account.id && session.status === "completed" && session.completedAt)
          .map((session) => localDay(session.completedAt!, this.state.settings.timeZone)))].sort();
        if (days.length === 0 && account.lastWarmupAt) days.push(localDay(account.lastWarmupAt, this.state.settings.timeZone));
        account.warmupLocalDays = days;
        account.trustScore = Math.min(100, days.length * 25);
      }
    }
    for (const user of this.state.users) {
      user.planId ??= "free";
      user.licenseKey ??= `HEISS-LOCAL-${user.id.slice(0, 8).toUpperCase()}`;
      user.trialEndsAt ??= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    // A persisted "running" session means the owning process disappeared
    // before a clean completion. Recover it through the checkpoint path.
    const orphaned = new Set<string>();
    for (const session of this.state.sessions) {
      if (session.status === "running" && !pidIsAlive(session.ownerPid)) {
        session.status = "checkpointed";
        orphaned.add(session.id);
      }
    }
    // A session orphaned by a dead controller must not keep the device or
    // content locked. Its resume re-acquires cleanly, and releasing the stale
    // lock frees the device for other consumers (the preflight canary, a fresh
    // controller) instead of blocking it until a full resume happens to run.
    const locks = this.state.locks ?? { devices: {}, content: {} };
    for (const [deviceId, holder] of Object.entries(locks.devices)) {
      if (orphaned.has(holder)) delete locks.devices[deviceId];
    }
    for (const [itemId, holder] of Object.entries(locks.content)) {
      if (orphaned.has(holder)) delete locks.content[itemId];
    }
    this.state.locks = locks;
    this.locks = new ResourceLocks();
    this.locks.restore(locks);
  }

  save(): void {
    if (existsSync(this.path)) {
      const current = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FarmState>;
      const currentRevision = current.revision ?? 0;
      if (currentRevision !== this.loadedRevision) {
        throw new StoreConflictError(
          `Farm state changed in another process (loaded revision ${this.loadedRevision}, current ${currentRevision}); retry the command`,
        );
      }
    }
    this.state.locks = this.locks.snapshot();
    this.state.revision = this.loadedRevision + 1;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(temp, this.path);
      this.loadedRevision = this.state.revision;
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }

  pushActivity(event: Omit<ActivityEvent, "id" | "at"> & { id?: string; at?: string }): ActivityEvent {
    const full: ActivityEvent = {
      id: event.id ?? cryptoRandom(),
      at: event.at ?? new Date().toISOString(),
      accountId: event.accountId,
      deviceId: event.deviceId,
      sessionId: event.sessionId,
      kind: event.kind,
      message: event.message,
      meta: event.meta,
    };
    this.state.activity.push(full);
    return full;
  }
}

function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random()}`;
}

function pidIsAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
