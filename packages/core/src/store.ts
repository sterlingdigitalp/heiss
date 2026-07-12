import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityEvent,
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
  contents: ContentAsset[];
  queue: QueueItem[];
  slots: ScheduleSlot[];
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
    contents: [],
    queue: [],
    slots: [],
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
    for (const user of this.state.users) {
      user.planId ??= "free";
      user.licenseKey ??= `HEISS-LOCAL-${user.id.slice(0, 8).toUpperCase()}`;
      user.trialEndsAt ??= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    // A persisted "running" session means the owning process disappeared
    // before a clean completion. Recover it through the checkpoint path.
    for (const session of this.state.sessions) {
      if (session.status === "running" && !pidIsAlive(session.ownerPid)) {
        session.status = "checkpointed";
      }
    }
    this.locks = new ResourceLocks();
    this.locks.restore(this.state.locks ?? { devices: {}, content: {} });
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
